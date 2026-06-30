# Starvation/Blocking-Based Bottleneck Detection — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Area:** `src/metrics/collector.js` (bottleneck detection), with downstream consumers.

## Problem

The current bottleneck detector uses a single signal: it averages each
station's machine utilization (`ticksProcessing / totalTicks`) and flags
**every** station above an absolute 60% threshold (`collector.js:101-104`),
suggesting "add a parallel machine" for each.

This is not a realistic bottleneck analysis:

- A bottleneck is **relative** — the resource that constrains the whole line's
  throughput — not "every station that happens to be busy." An absolute
  threshold flags many stations at once or none on a balanced line.
- The classic diagnostic is **ignored even though the data exists**: a true
  constraint is busy while it is *not blocked*, its downstream is *starved*
  (waiting on its output), and WIP *piles up in front of it*. A station that is
  busy-but-blocked is a **victim** of a downstream constraint, not the
  constraint itself — yet today it gets flagged.

The simulation already tracks `ticksBlocked`, `ticksStarved`, buffer
`load`/`capacity`, and `avgQueueWait`. None feed the bottleneck decision.

## Goals

Refine detection to identify the **true constraint(s)** using the
starvation/blocking flow pattern, demoting busy-but-blocked victims. Keep the
teaching focus, the existing suggestion shape, and the German UI language.

## Non-Goals (YAGNI)

- Time-windowed / trending utilization (everything stays cumulative from tick 0).
- Per-machine (vs station) constraint resolution within a parallel group.
- Cause-differentiated suggestion *types* beyond the one diagnostic note below.
  (`add-parallel-machine` remains the only spawn suggestion.)

## Decisions (from brainstorming)

1. **Refine, don't replace.** Utilization stays as the "is this station busy?"
   gate; the flow signals confirm/rank the true constraint and disqualify
   victims.
2. **Report only true constraint(s).** Busy-but-blocked stations stop being
   flagged (`bottleneck: false`); they get a `flowState` explaining why.
3. **Topology-aware.** The flow test inspects neighbors (downstream starvation,
   upstream buffer fill) via the buffer→machine links.
4. **Gates + confidence score**, not a strict four-way AND. Two reliable
   conditions are hard gates; two fragile flow signals raise a confidence score
   but are not required, avoiding false negatives on balanced/tiny-buffer lines.
5. **Diagnostic note** (not a spawn suggestion) when the line is source-starved
   and has no internal constraint.

## Topology

The line is a strictly **linear chain**, confirmed in `config.js` /
`engine.js:280-300`:

```
Source → BUF0 → S1 → BUF1 → S2 → BUF2 → S3 → BUF3 → S4 → Sink
```

Parallel machines within a station share one input buffer and one output
buffer. Therefore each station has exactly:

- **one upstream buffer** = `inputBufferId` (shared by its machines)
- **one downstream station** = the station whose `inputBufferId` equals this
  station's `outputBufferId` (`null`/none for the last station)

No splits or merges exist, so the graph walk is a simple buffer-id lookup. Build
a `Map` from `outputBufferId → downstream station` once per `calculateMetrics`
call.

## Algorithm

### Per-station aggregation

Across a station's parallel machines, all as ratios of summed total ticks
(`totalTicks = ticksProcessing + ticksBlocked + ticksStarved + ticksIdle`):

- `avgUtil`      = Σ`ticksProcessing` / Σ`totalTicks`  *(already computed)*
- `blockedRatio` = Σ`ticksBlocked`    / Σ`totalTicks`
- `starvedRatio` = Σ`ticksStarved`    / Σ`totalTicks`
- `inputFill`    = upstream buffer `load / capacity`  (snapshot)
- `downstream`   = downstream station via the topology map (or `null`)

### Constraint test

A station is a **true constraint** when both hard gates hold:

| Condition | Test | Rationale |
|---|---|---|
| **Busy** (hard gate) | `avgUtil > UTIL_THRESHOLD` (0.6) | Must actually be working hard. |
| **Not blocked** (hard gate) | `blockedRatio < BLOCKED_MAX` (0.05) | A blocked station waits on *downstream* → it is a victim, not the constraint. |

Two **confirming signals** do not gate but raise confidence:

| Signal | Measure | Rationale |
|---|---|---|
| **Starves downstream** | `downstream.starvedRatio` (treat as fully satisfied if no downstream) | The constraint paces everyone after it; they sit idle waiting for its output. |
| **Upstream backs up** | `inputFill` (and/or elevated `avgQueueWait`) | WIP piles up in front of the constraint. |

### Confidence score

Computed only for stations that pass both hard gates. `clamp(x)` clamps to
`[0,1]`:

```
confidence = w_util   * clamp(avgUtil)
           + w_block  * (1 - blockedRatio / BLOCKED_MAX)
           + w_starve * starveTerm
           + w_fill   * clamp(inputFill)

where starveTerm = clamp(downstream.starvedRatio)   if a downstream exists
                 = 1                                  if this is the last station
```

Proposed weights (sum to 1): `w_util = 0.4`, `w_block = 0.2`,
`w_starve = 0.2`, `w_fill = 0.2`. All weights and thresholds are named
constants at the top of `collector.js`, alongside the existing
`BOTTLENECK_UTIL_THRESHOLD`.

### Ranking & flags

- Constraint stations are ranked by `confidence` descending.
- The top-ranked station gets `isPrimaryConstraint: true`.
- Only gate-passing (constraint) stations get `bottleneck: true`. Busy-but-
  blocked stations get `bottleneck: false`.

### `flowState` classification (per machine/station)

- `CONSTRAINT` — passes the hard gates (a true bottleneck).
- `BLOCKED_BY_DOWNSTREAM` — `blockedRatio` high (≥ `BLOCKED_MAX`); a victim of a
  downstream constraint.
- `STARVED_BY_UPSTREAM` — `starvedRatio ≥ STARVED_MIN`; waiting on upstream supply.
- `BALANCED` — none of the above dominates.

(Precedence when classifying: CONSTRAINT > BLOCKED_BY_DOWNSTREAM >
STARVED_BY_UPSTREAM > BALANCED.)

### Edge cases

- **Last station** (no downstream): the starve term contributes its full weight
  (it cannot starve anything, so it is not penalized). It can still be the
  constraint.
- **Nothing passes the gates** (whole line starved from the source, or
  everything blocked): return **zero bottlenecks** plus one **diagnostic note**
  (see below). This is the honest answer and teaches that not every slow line
  has an internal bottleneck.
- **Source-starved guard:** the diagnostic note is emitted when **no station
  passes the gates** AND either the first station's own `starvedRatio ≥
  STARVED_MIN` (source / arrival rate is the limiter) or some station is busy
  but disqualified (e.g. everything blocked). A genuine internal constraint
  (busy + not blocked) is always reported and takes precedence — the guard only
  applies when there is no internal constraint to report.

## Output Shape

### Per-machine metrics (additive — existing fields untouched)

```js
{
  // existing: id, stationId, name, utilization, avgQueueWait,
  //           blockedTime, starvedTime, currentState, bottleneck
  blockedRatio,          // 0–1
  starvedRatio,          // 0–1
  flowState,             // 'CONSTRAINT' | 'BLOCKED_BY_DOWNSTREAM'
                         // | 'STARVED_BY_UPSTREAM' | 'BALANCED'
  isPrimaryConstraint,   // bool — the single top-ranked constraint
}
```

`bottleneck` now means "passed the constraint gates" (not "util > 0.6"), so a
busy-but-blocked machine flips to `bottleneck: false` with
`flowState: 'BLOCKED_BY_DOWNSTREAM'` — the core fix.

### Suggestions

Existing shape (`type, stationId, machineId, avgUtil, threshold, label,
reason`) plus:

```js
{
  confidence,   // 0–1, used for ordering and display
  flowState,    // why this station is the constraint
}
```

- Ordered by `confidence` (was `avgUtil`).
- The German `reason` is rewritten to explain the flow logic, e.g.:
  *"…ist der Engpass: hohe Auslastung (X%), kaum blockiert (Y%), und die
  nachgelagerte Station wartet (Z% Leerlauf) — Teile stauen sich davor."*
- The `add-parallel-machine` cap (`MAX_MACHINES_PER_STATION`) and the
  "flagged-but-no-suggestion when at cap" behavior stay as-is.

### Diagnostic note (new)

For the source-starved / no-internal-constraint case, emit one suggestion-shaped
entry with no spawn affordance:

```js
{
  type: 'no-internal-constraint',
  // no machineId / no spawn button
  reason: 'Kein interner Engpass — die Linie wird von der Quelle / der '
        + 'Ankunftsrate begrenzt.',
}
```

## Testing & Integration Impact

### `test/collector.test.js`

The current fixture auto-fills `ticksStarved` and defaults `ticksBlocked: 0`,
so today every busy machine trivially passes. New fixtures must set
`blocked`/`starved` explicitly and include buffer `load`/`capacity` plus
topology so the graph walk resolves. Test intent changes/additions:

- "multiple saturated stations all flagged" → now **only gate-passers** flag; a
  busy-but-blocked station asserts `bottleneck: false`,
  `flowState: 'BLOCKED_BY_DOWNSTREAM'`.
- Clean constraint (busy + not-blocked + downstream starved) →
  `isPrimaryConstraint: true`.
- Blocked-downstream victim demoted (not flagged).
- Source-starved line → zero bottlenecks + one `no-internal-constraint` note.
- Last-station-as-constraint (no downstream) flags correctly.
- Confidence ordering of multiple constraints.

### Consumers

- **`src/metrics/prometheus.js`** — `plantsim_machine_is_bottleneck` semantics
  shift (fewer 1s). Optionally add `plantsim_machine_is_primary_constraint`
  gauge and/or a `flow_state` label.
- **`src/opcua/server.js`** — `bottleneckId` now = the primary constraint
  (cleaner; previously first-of-many).
- **`src/public/app.js`** — may render `flowState` (distinguish blocked-victim
  vs constraint coloring) and the diagnostic note; the existing orange
  bottleneck stroke now marks only true constraints.

## Constants (new, top of `collector.js`)

```js
const BOTTLENECK_UTIL_THRESHOLD = 0.6;   // existing — "busy" gate
const BLOCKED_MAX               = 0.05;  // "not blocked" gate
const STARVED_MIN               = 0.10;  // "starved" classification / source-starved guard
const W_UTIL                    = 0.4;   // confidence weights …
const W_BLOCK                   = 0.2;
const W_STARVE                  = 0.2;
const W_FILL                    = 0.2;
```

`MAX_MACHINES_PER_STATION` (4) is unchanged.
