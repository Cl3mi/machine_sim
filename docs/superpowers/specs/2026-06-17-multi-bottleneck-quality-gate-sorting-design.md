# Design: Multi-bottleneck detection, per-machine quality gates, grouped machine sorting

**Date:** 2026-06-17
**Status:** Approved

## Problem

Three issues in the PlantSim PoC:

1. **Bottleneck (Engpass) detection flags only one station at a time.**
   `collector.js` selects the single highest-utilization station as *the*
   bottleneck and emits one suggestion. When several stations are saturated,
   only one is surfaced.
2. **The quality gate is hardwired to M2.**
   The engine supports `rejectRate` per machine, but the UI exposes a single
   global reject-rate slider that always targets `M2`, and the scrap label
   assumes one rejecting machine. There is no way to make another machine a
   quality gate or to run several gates at once.
3. **Machine cycle-time ordering is messy.**
   Spawned parallel machines (e.g. `M3b`) are appended to the config array
   after `M4`, so the cycle-time sliders and the dashboard machine table render
   in config order — `M1, M2, M3, M4, M3b` — splitting a station apart.

## Goals

- Detect and surface **multiple** simultaneous bottlenecks.
- Make the quality gate **choosable per machine**, with several gates allowed.
- Keep parallel machines **grouped together** in pipeline order in both the
  cycle-time sliders and the machine table.

## Non-goals

- No change to the simulation tick loop or the `rejectRate` mechanic itself
  (the engine already rejects per machine).
- No new scrap sinks — all gates continue to feed the single shared scrap sink.
- No change to spawn/remove machine behavior.

## Design

### 1. Multiple bottleneck detection — `src/metrics/collector.js`

Replace the single-winner selection with a flag-all approach:

- Compute each station's average machine utilization (as today).
- Flag **every** station whose average utilization exceeds
  `BOTTLENECK_UTIL_THRESHOLD`: set `bottleneck: true` on all machines of those
  stations.
- Build a **`suggestions` array** instead of a single `suggestion`. For each
  flagged station that still has room (`stationMachines.length <
  MAX_MACHINES_PER_STATION`), push one `add-parallel-machine` entry
  (`{ type, stationId, machineId, label }`, same shape as the current single
  suggestion). Sort the array by station average utilization descending
  (worst first).
- The returned metrics object exposes `suggestions: [...]` and no longer has a
  singular `suggestion` field.

Compatibility: the per-machine `bottleneck` boolean keeps its shape, so
`prometheus.js` (`plantsim_machine_is_bottleneck`) and `opcua/server.js`
(`bottleneckId = metrics.machines.find(m => m.bottleneck)?.id`) continue to
work — they now naturally report more than one bottleneck machine.

### 2. Suggestion banner renders all suggestions — `src/public/app.js`

`updateSuggestionBanner(metrics)` reads `metrics.suggestions`:

- Hidden when the array is empty/absent.
- Otherwise renders one row per suggestion (worst first), each with its own
  "+ Parallele Maschine hinzufügen" button wired to
  `postControl({ stationId: s.stationId }, 'spawnMachine')`.

### 3. Per-machine quality gate — `index.html` + `app.js`

- **Remove** the global "Quality Gate (M2)" controls row from `index.html`
  (the `#reject-rate` slider), its `input` handler in `app.js`, and the
  M2-specific reject-slider block in `applyReset`.
- In the **machine detail panel**, replace the read-only "Reject rate" stat
  with an editable range input (0–50%, step 1) shown for **every** machine.
  On input it posts `{ machineId, rejectRate: value / 100 }`. The current
  value is populated from `state` each frame in `updateMachineDetail` and on
  `openMachineDetail`.
- Raising any machine's reject rate above 0 turns it into a quality gate;
  several gates coexist. The engine and the per-machine scrap connectors in
  `computeLayout` already support multiple rejecting machines.
- The single `scrap-rate-label` above the scrap sink (which only ever showed
  the first gate's percentage) is blanked — per-gate rates now live in each
  machine's detail panel. The scrap **count** is unchanged.

### 4. Grouped machine sorting — `app.js`

Add a helper:

```js
// Group machines by station in pipeline (first-appearance) order,
// sorted within a station by id, so parallels stay together.
function orderedMachines(machines) {
  const stationFirstIndex = new Map();
  machines.forEach((m, i) => {
    if (!stationFirstIndex.has(m.stationId)) stationFirstIndex.set(m.stationId, i);
  });
  return [...machines].sort((a, b) => {
    const sa = stationFirstIndex.get(a.stationId);
    const sb = stationFirstIndex.get(b.stationId);
    return sa !== sb ? sa - sb : a.id.localeCompare(b.id);
  });
}
```

Apply it to the iteration source in:
- `buildControlSliders` — cycle-time slider order.
- `updateMetricsDashboard` — machine table row order.

Pipeline order is preserved because the original station machines (`M1`..`M4`)
appear in config order, so the first occurrence of each `stationId` is already
in pipeline order; spawned machines share their station's id and sort after the
original by id (`M3` < `M3b` < `M3c`).

## Testing

- `test/collector.test.js`: extend/adjust for the new behavior —
  - multiple stations above the threshold are all flagged `bottleneck: true`;
  - `suggestions` is an array, ordered worst-utilization-first, with one entry
    per flagged station that has room;
  - a full station (at `MAX_MACHINES_PER_STATION`) is flagged but produces no
    suggestion;
  - no stations above threshold ⇒ empty `suggestions`, no machine flagged.
- Follow TDD: update the tests first, watch them fail, then change
  `collector.js`.
- Front-end changes (`app.js`, `index.html`) are verified manually by running
  the app (per-machine gate slider, multi-suggestion banner, grouped sliders
  and table after spawning a parallel machine).

## Files touched

- `src/metrics/collector.js` — multi-flag + `suggestions` array.
- `src/public/app.js` — banner loop, per-machine reject slider, `orderedMachines`, remove global reject handler.
- `src/public/index.html` — remove global quality-gate row, editable reject input in detail panel.
- `test/collector.test.js` — updated assertions.
