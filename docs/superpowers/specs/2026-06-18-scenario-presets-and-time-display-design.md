# Scenario Presets & Simulated-Time Display — Design

**Date:** 2026-06-18
**Status:** Approved, pending implementation plan

## Problem

The simulation always starts from one default config. To teach specific lessons,
an instructor needs to quickly load curated scenarios that demonstrate a single
concept (a clear bottleneck, a well-balanced line, a starved line) without
manually dialing in cycle times, buffer sizes, and source intervals each time.

Separately, the header only reports the raw `tick` count, which is abstract for
learners. A human-readable elapsed time in seconds makes the run easier to reason
about.

## Goals

- Provide a small set of **curated, read-only** scenario presets the user can load
  with one click. The user cannot create, edit, or save presets — they are code.
- After loading a preset, give clear feedback ("Preset loaded") and leave the
  simulation **paused at tick 0**, so the user explicitly presses Start.
- Show **simulated elapsed time in seconds** in the header alongside the tick count.

## Non-Goals (YAGNI)

- User-created, editable, or persisted presets.
- A preset management UI beyond load buttons.
- Wall-clock timing (the seconds value is simulated time, not real time).

## Presets

Three presets, each a **complete** simulation config (source, machines, buffers):

| id           | label (UI)                  | Teaching point |
|--------------|-----------------------------|----------------|
| `bottleneck` | Engpass (Montage)           | One slow station (M3 Montage, high cycle time) with tight downstream buffers becomes the single clear constraint; upstream blocks, downstream starves. |
| `balanced`   | Ausbalanciert               | Cycle times and buffer sizes tuned so utilization is high and even — no single bottleneck, smooth flow / best throughput. |
| `starvation` | Materialmangel (Quelle)     | Source `interval` is large, so machines sit STARVED waiting for parts most of the time. |

Concrete numbers are finalized during implementation; the constraint is that each
config validates against the existing config shape (every machine's
`inputBufferId`/`outputBufferId` references a defined buffer or the sink).

## Architecture

Server-side preset registry; the frontend only knows preset **ids and labels**, not
the configs. This keeps a single source of truth and makes presets impossible for
users to add.

### 1. `src/simulation/presets.js` (new)

- Exports `PRESETS`: an ordered array of `{ id, label, description, config }`.
- `config` is a full config object with the same shape as `DEFAULT_CONFIG`.
- Helper `getPreset(id)` returns a **deep clone** of the matching `config`, or
  `undefined` if the id is unknown.

### 2. `src/simulation/engine.js`

- New method `loadConfig(config)`: pauses, deep-clones `config` into `this._config`,
  resets `this._nextPartId`, and calls `this._reset()`. Leaves the engine **paused
  at tick 0** (does not auto-play). This is the `resetToDefaults()` pattern,
  parameterized by an arbitrary config.
- `getState()` gains `ticksPerSecond: this._config.ticksPerSecond` so the frontend
  can compute simulated seconds.

### 3. `src/server.js`

- New `GET /api/presets` → returns metadata only:
  `PRESETS.map(({ id, label, description }) => ({ id, label, description }))`.
- `POST /api/control` gains `case 'loadPreset'`: looks up `params.presetId` via
  `getPreset`; if found, `engine.loadConfig(cfg)`; if not, the response indicates
  failure (`{ ok: false }`) and the engine is untouched.

### 4. Frontend — `src/public/index.html` + `src/public/app.js`

- **Header time display:** add `<span>Zeit: <strong id="time-counter">0.0</strong> s</span>`
  beside the tick counter. In the render loop:
  `setTextContent('time-counter', (state.tick / state.ticksPerSecond).toFixed(1))`.
- **Scenario controls:** add a "Szenarien" controls-row in the controls section.
  On page load, `app.js` fetches `/api/presets` and renders one button per preset
  (label from server, `data-preset-id` attribute).
- **Load + feedback:** clicking a preset button POSTs
  `{ action: 'loadPreset', params: { presetId } }`. On `ok`, show a transient toast
  **"✓ Preset ‹label› geladen – jetzt starten"** that auto-dismisses after ~3s.
  Because the engine is paused at tick 0, the existing start-banner reappears,
  reinforcing that the user must press Start.

## Data Flow

```
[page load] app.js --GET /api/presets--> server --> [{id,label,description}]
            app.js renders preset buttons

[click preset] app.js --POST /api/control {loadPreset, presetId}--> server
               server: getPreset(id) -> engine.loadConfig(cfg)  (paused, tick 0)
               app.js: show toast, start-banner reappears via SSE state

[every SSE tick] state.tick / state.ticksPerSecond -> header "Zeit: X.X s"
```

## Error Handling

- Unknown `presetId`: server returns `{ ok: false }`; engine state unchanged; no
  toast (or a non-blocking error). Should not happen via the UI since buttons come
  from `/api/presets`, but the server validates regardless.
- `/api/presets` fetch failure on the client: the scenario row simply renders no
  buttons; the rest of the app is unaffected.

## Testing (`node --test`, TDD)

- `test/presets.test.js`:
  - Every preset has `id`, `label`, `description`, `config`.
  - Each `config` validates: machines reference defined buffers (or `null` → sink);
    buffers have positive capacity; source has `interval`/`materialStock`.
  - `getPreset(knownId)` returns a config that is a clone (mutating it does not
    affect the registry); `getPreset(unknownId)` returns `undefined`.
- `test/engine` (extend existing or new): `loadConfig`
  - resets `tick` to 0,
  - leaves the engine paused (`running === false`),
  - applies the new config (e.g. a machine cycleTime from the preset shows in state),
  - exposes `ticksPerSecond` in `getState()`.
```
