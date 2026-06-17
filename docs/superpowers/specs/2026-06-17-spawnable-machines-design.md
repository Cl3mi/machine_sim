# Spawnable Parallel Machines + Bottleneck Suggestion — Design

**Date:** 2026-06-17
**Status:** Approved (pending implementation plan)

## Goal

Let students add (and remove) **parallel machines** at a station to relieve a
bottleneck, and make bottleneck detection actively **suggest spawning one
additional machine** at the constraining station.

A "parallel machine" is a second (or third…) machine that works **alongside**
an existing station's machine, sharing the same upstream and downstream buffer:

```
BUF2 ──┬──► M3a ──┬──► BUF3
       └──► M3b ──┘
  (two "Montage" machines pull from BUF2, push to BUF3)
```

Adding a parallel machine roughly doubles a station's throughput, which is the
classic remedy for a bottleneck and the pedagogical payoff: the student watches
the constraint move elsewhere.

## Decisions (from brainstorming)

- **Spawn model:** parallel machine at a station (shares the station's input +
  output buffer). Not "append at end", not "insert anywhere".
- **Trigger / UX:** a suggestion banner with an action button when a bottleneck
  exists, plus a manual +/- control per station. Nothing auto-spawns — the
  student decides.
- **Removal:** supported, down to the original 1 machine per station.
- **Reset behavior:** `reset()` keeps spawned machines (consistent with how it
  already preserves adjusted cycle times); `resetToDefaults()` removes them,
  restoring the original 4-machine line.
- **Cap:** maximum 4 machines per station (original + 3).

## 1. Core model change — explicit wiring

The engine currently hardcodes the linear mapping `machines[i] ↔ buffers[i]`
(upstream) and `buffers[i+1]` (downstream). Parallel machines break the 1:1
assumption, so each machine becomes **self-describing**:

```js
{ id:'M3', stationId:'S3', name:'Montage', cycleTime:15,
  inputBufferId:'BUF2', outputBufferId:'BUF3' }   // outputBufferId:null ⇒ Sink
```

- A **station** is the set of machines sharing a `stationId` (hence the same
  `inputBufferId` and `outputBufferId`).
- `DEFAULT_CONFIG.machines` gains `stationId`, `inputBufferId`, `outputBufferId`
  on every machine. Station ids: S1–S4. M4's `outputBufferId` is `null` (Sink).
- A one-time graph walk from the source's output buffer (BUF0) assigns each
  station an integer `order` (0,1,2,…). The engine processes machines
  **downstream→upstream** (descending order) to preserve the existing
  domino-prevention guarantee. Parallel machines share an order rank; their
  relative processing order is arbitrary, and competition for shared buffer
  slots is correct behavior.

## 2. Engine (`src/simulation/engine.js`)

### Tick loop
- Build a processing order: machines sorted by station `order` descending.
- STEP 1 (advance) and STEP 3 (pull) use `inputBufferId` / `outputBufferId`
  buffer lookups instead of `buffers[i]` / `buffers[i+1]`.
- `_tryPushDownstream`: if `outputBufferId === null` ⇒ push to Sink; else push
  to the buffer with that id (BLOCKED if full, as today).

### New methods
- `spawnMachine({ stationId })`:
  - Find the station's template machine (first machine with that `stationId`).
  - Reject if the station already has 4 machines (cap) or the station doesn't
    exist.
  - New id by suffix: base id of the station's first machine + next free letter
    (`M3` → `M3b` → `M3c` → `M3d`).
  - Clone `name`, `cycleTime`, `rejectRate`, `inputBufferId`, `outputBufferId`,
    `stationId`. New machine starts IDLE with no part.
  - Append to both `this.machines` and `this._config.machines` (so `reset()`
    preserves it).
- `removeMachine({ machineId })`:
  - Reject if the machine doesn't exist or its station has only 1 machine
    (the original cannot be removed).
  - If the machine currently holds a part, `unshift` it back onto its input
    buffer; if that buffer is full, the part is dropped (rare; documented).
  - Remove from both `this.machines` and `this._config.machines`.

### State
`getState()` machine entries gain `stationId`, `inputBufferId`,
`outputBufferId`. Existing fields unchanged.

### Persistence
No extra work: `reset()` already rebuilds from `_config`; `resetToDefaults()`
already restores `DEFAULT_CONFIG`.

## 3. Metrics + bottleneck detection (`src/metrics/collector.js`)

### Per-machine
- `avgQueueWait` uses the machine's `inputBufferId` (look up the buffer by id),
  not the positional `buffers[machineIndex]`.

### Bottleneck detection — switched to utilization-based, station-level
The current heuristic flags the machine with the highest **blocked** ratio,
which is the machine *upstream* of the real constraint (e.g. M2 blocks because
M3 is slow). Adding capacity there would be wrong. The true constraint is the
busiest station.

New rule:
- Group machines by `stationId`. A station's utilization = average
  processing-utilization of its machines.
- Bottleneck station = the station with the highest average utilization,
  provided it exceeds a threshold (`BOTTLENECK_UTIL_THRESHOLD = 0.6`).
- Every machine in the bottleneck station gets `bottleneck: true` (drives the
  existing ⚠ ENGPASS marker and table badge unchanged).
- When a parallel machine is added, per-machine utilization drops, so the
  bottleneck visibly moves — the intended teaching feedback.

### Suggestion
New field on the metrics object:
```js
suggestion: {
  type: 'add-parallel-machine',
  stationId: 'S3',
  machineId: 'M3',            // representative machine of the station
  label: 'M3 (Montage) ist der Engpass — füge 1 parallele Maschine hinzu.'
} | null
```
Present only when a bottleneck station exists **and** it is below the
4-machine cap. `null` otherwise.

## 4. Server (`src/server.js`)

Add two cases to the `/api/control` switch, dispatched to the session engine:
- `spawnMachine`  → `engine.spawnMachine(params)`
- `removeMachine` → `engine.removeMachine(params)`

No other route changes. The SSE loop already streams `{ state, metrics }`, so
the new `suggestion` and machine fields flow to the client automatically.

## 5. Frontend (`src/public/app.js`) — data-driven layout

Replace the hardcoded `LAYOUT`, `CONNECTORS`, and fixed draw-calls with a
layout **computed from state** whenever the machine set changes.

### Layout
- Reconstruct column order by walking the buffer graph:
  `SOURCE → BUF0 → station(S1) → BUF1 → station(S2) → … → SINK`.
- Assign x positions by column index (fixed horizontal spacing).
- Stack a station's machines vertically, centered on the main line; grow the
  SVG `viewBox` height to fit the deepest stack.

### Connectors + particles
- Generate connectors per machine:
  `conn-<inputBufId>-<machineId>` (buffer→machine) and
  `conn-<machineId>-<outputBufId|sink>` (machine→downstream), plus a scrap
  branch from any machine with `rejectRate > 0`.
- `detectTransfers` becomes generic: for each machine, a positive
  `partsProcessed` delta spawns a particle on that machine's output connector;
  scrap delta handled per rejecting machine. Buffer-pull particles keyed by
  each machine's input connector.
- The particle pool / rAF loop / jam logic is unchanged — only connector
  identity/geometry is now dynamic.

### Suggestion banner + station controls
- A banner above the pipeline renders `metrics.suggestion` with a
  **[+ Parallele Maschine hinzufügen]** button → `postControl({stationId},
  'spawnMachine')`. Hidden when `suggestion` is null.
- Each station exposes a small **+ / –** control (in the machine detail panel
  and/or beneath the station) → `spawnMachine` / `removeMachine`. The `–`
  control is disabled when the station has only its original machine.
- Rebuild the SVG layout and the control sliders whenever the set of machines
  changes (detected by comparing machine ids between frames).

## 6. Testing

The repo has no test runner today. Add lightweight **`node:test`** unit tests
(no new dependency; fits the no-build-step ethos) and a `"test": "node --test"`
script. Cover the pure logic:
- Engine: `spawnMachine` clones wiring and respects the cap; `removeMachine`
  refuses the last machine and returns a held part to the input buffer;
  station-ordered processing still prevents domino cascades; two parallel
  machines roughly double a station's throughput.
- Collector: utilization-based bottleneck flags the correct station; suggestion
  appears for a bottleneck below cap and is null otherwise.

## Out of scope

- OPC-UA: the address space is built once at startup from a separate,
  non-spawning engine instance. Spawned machines won't appear in OPC-UA. Not
  addressed here.
- Inserting new sequential stations (a different feature). Only parallel
  machines at existing stations are in scope.
