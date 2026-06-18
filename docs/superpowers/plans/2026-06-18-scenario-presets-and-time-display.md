# Scenario Presets & Simulated-Time Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three curated, read-only scenario presets the user can load with one click (with "preset loaded" feedback, leaving the sim paused), plus a simulated-time-in-seconds display in the header.

**Architecture:** Presets live server-side as full config objects in a new `presets.js`. The engine gains a `loadConfig(config)` method (the `resetToDefaults()` pattern, parameterized). The server exposes preset metadata via `GET /api/presets` and a `loadPreset` control action. The frontend fetches preset metadata, renders one button per preset, and on click POSTs `loadPreset` then rebuilds the pipeline (reusing the existing reset flow) and shows a transient toast. The header derives seconds from `state.tick / state.ticksPerSecond`.

**Tech Stack:** Node.js ESM, Fastify, vanilla HTML/CSS/JS, `node:test`.

Spec: `docs/superpowers/specs/2026-06-18-scenario-presets-and-time-display-design.md`

---

## File Structure

- **Create** `src/simulation/presets.js` — the preset registry (`PRESETS` array + `getPreset(id)`).
- **Create** `test/presets.test.js` — validates preset shape and `getPreset`.
- **Modify** `src/simulation/engine.js` — add `loadConfig(config)`; add `ticksPerSecond` to `getState()`.
- **Modify** `test/engine.test.js` — tests for `loadConfig` and `ticksPerSecond` in state.
- **Modify** `src/server.js` — `GET /api/presets`; `loadPreset` case in `POST /api/control`.
- **Modify** `src/public/index.html` — header time span; "Szenarien" controls row; toast element.
- **Modify** `src/public/app.js` — render seconds; fetch + render preset buttons; load handler + toast.

---

## Task 1: Preset registry

**Files:**
- Create: `src/simulation/presets.js`
- Test: `test/presets.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/presets.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset } from '../src/simulation/presets.js';

// Every machine's buffer references must resolve to a defined buffer (or null = sink).
function assertValidConfig(cfg, label) {
  assert.ok(cfg.source && typeof cfg.source.interval === 'number', `${label}: source.interval`);
  assert.ok(typeof cfg.source.materialStock === 'number', `${label}: source.materialStock`);
  assert.ok(typeof cfg.ticksPerSecond === 'number', `${label}: ticksPerSecond`);
  assert.ok(Array.isArray(cfg.machines) && cfg.machines.length > 0, `${label}: machines`);
  assert.ok(Array.isArray(cfg.buffers) && cfg.buffers.length > 0, `${label}: buffers`);
  const bufferIds = new Set(cfg.buffers.map(b => b.id));
  for (const b of cfg.buffers) {
    assert.ok(b.capacity > 0, `${label}: buffer ${b.id} capacity > 0`);
  }
  for (const m of cfg.machines) {
    assert.ok(bufferIds.has(m.inputBufferId), `${label}: machine ${m.id} inputBuffer exists`);
    assert.ok(m.outputBufferId === null || bufferIds.has(m.outputBufferId),
      `${label}: machine ${m.id} outputBuffer exists or null`);
    assert.ok(m.cycleTime > 0, `${label}: machine ${m.id} cycleTime > 0`);
  }
}

test('every preset has required metadata and a valid config', () => {
  assert.ok(PRESETS.length >= 3, 'at least three presets');
  for (const p of PRESETS) {
    assert.ok(typeof p.id === 'string' && p.id.length, `preset id: ${JSON.stringify(p)}`);
    assert.ok(typeof p.label === 'string' && p.label.length, `preset label: ${p.id}`);
    assert.ok(typeof p.description === 'string' && p.description.length, `preset description: ${p.id}`);
    assertValidConfig(p.config, p.id);
  }
});

test('preset ids are unique', () => {
  const ids = PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('getPreset returns a deep clone, not the registry object', () => {
  const cfg = getPreset('bottleneck');
  assert.ok(cfg, 'bottleneck preset exists');
  cfg.machines[0].cycleTime = 9999;
  const fresh = getPreset('bottleneck');
  assert.notEqual(fresh.machines[0].cycleTime, 9999, 'mutation leaked into registry');
});

test('getPreset returns undefined for an unknown id', () => {
  assert.equal(getPreset('does-not-exist'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/presets.test.js`
Expected: FAIL — cannot find module `../src/simulation/presets.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/simulation/presets.js`:

```javascript
/**
 * presets.js
 * Curated, read-only teaching scenarios. Each preset is a COMPLETE simulation
 * config (same shape as DEFAULT_CONFIG) chosen to demonstrate one concept.
 * Users cannot add presets — they are code. Loaded via POST /api/control
 * { action: 'loadPreset', params: { presetId } }, which leaves the engine
 * paused at tick 0 so the user presses Start explicitly.
 */

export const PRESETS = [
  {
    id: 'bottleneck',
    label: 'Engpass (Montage)',
    description: 'Eine langsame Station (M3 Montage) wird zum klaren Engpass: davor staut es sich, dahinter herrscht Leerlauf.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 2, materialStock: -1 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 3,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 18,                  inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
  {
    id: 'balanced',
    label: 'Ausbalanciert',
    description: 'Taktzeiten und Puffer sind aufeinander abgestimmt — gleichmäßig hohe Auslastung, kein einzelner Engpass.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 4, materialStock: -1 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 4,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 4, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 4,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 4,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 4 },
        { id: 'BUF2', capacity: 4 },
        { id: 'BUF3', capacity: 4 },
      ],
    },
  },
  {
    id: 'starvation',
    label: 'Materialmangel (Quelle)',
    description: 'Die Quelle liefert zu langsam — die Maschinen stehen die meiste Zeit ausgehungert (STARVED) still.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 12, materialStock: -1 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 4,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 4,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
];

// Returns a deep clone of the named preset's config, or undefined if unknown.
// Cloning protects the registry from mutation by the engine.
export function getPreset(id) {
  const preset = PRESETS.find(p => p.id === id);
  return preset ? JSON.parse(JSON.stringify(preset.config)) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/presets.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/simulation/presets.js test/presets.test.js
git commit -m "feat: add curated scenario preset registry"
```

---

## Task 2: Engine `loadConfig` + `ticksPerSecond` in state

**Files:**
- Modify: `src/simulation/engine.js` (add method after `resetToDefaults()` ~line 90; add field in `getState()` ~line 229)
- Test: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/engine.test.js`:

```javascript
test('loadConfig applies a new config, resets to tick 0, and stays paused', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG
  runTicks(engine, 50);
  assert.ok(engine.tick > 0, 'precondition: ticks advanced');

  engine.loadConfig(twoStationConfig(2, 6));

  const state = engine.getState();
  assert.equal(state.tick, 0, 'tick reset to 0');
  assert.equal(state.running, false, 'engine paused after loadConfig');
  assert.deepEqual(state.machines.map(m => m.id), ['A', 'B'], 'new machine set applied');
  assert.equal(state.machines.find(m => m.id === 'B').cycleTime, 6, 'new cycle time applied');
});

test('loadConfig deep-clones so later mutation of the source object does not leak', () => {
  const engine = new SimulationEngine();
  const cfg = twoStationConfig(2, 6);
  engine.loadConfig(cfg);
  cfg.machines[0].cycleTime = 9999;
  assert.notEqual(engine.getState().machines.find(m => m.id === 'A').cycleTime, 9999);
});

test('getState exposes ticksPerSecond from the active config', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG has ticksPerSecond 10
  assert.equal(engine.getState().ticksPerSecond, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/engine.test.js`
Expected: FAIL — `engine.loadConfig is not a function` and `ticksPerSecond` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/simulation/engine.js`, add the method immediately after `resetToDefaults()` (after line 90):

```javascript
  // Loads an arbitrary full config (e.g. a curated preset) — same effect as
  // resetToDefaults() but with a caller-supplied config instead of DEFAULT_CONFIG.
  // Deep-clones so the caller's object can't mutate engine state. Stays paused
  // at tick 0; call play() explicitly.
  loadConfig(config) {
    this.pause();
    this._nextPartId = 1;
    this._config = JSON.parse(JSON.stringify(config));
    this._reset();
  }
```

In `getState()`, add `ticksPerSecond` next to `tick` (line 229):

```javascript
      tick:     this.tick,
      ticksPerSecond: this._config.ticksPerSecond,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/engine.test.js`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/simulation/engine.js test/engine.test.js
git commit -m "feat: engine loadConfig + expose ticksPerSecond in state"
```

---

## Task 3: Server endpoints (`GET /api/presets` + `loadPreset` action)

**Files:**
- Modify: `src/server.js` (import ~line 31; new route near `/api/state` ~line 152; new case in `POST /api/control` ~line 162)

- [ ] **Step 1: Add the import**

In `src/server.js`, after the `DEFAULT_CONFIG` import (line 31):

```javascript
import { PRESETS, getPreset }   from './simulation/presets.js';
```

- [ ] **Step 2: Add the `GET /api/presets` route**

Add immediately before the `POST /api/control` route (~line 156):

```javascript
// Curated scenario presets — metadata only (id/label/description), never the
// full configs. The frontend renders one load button per entry.
app.get('/api/presets', async () =>
  PRESETS.map(({ id, label, description }) => ({ id, label, description })));
```

- [ ] **Step 3: Add the `loadPreset` case**

In the `switch (action)` block of `POST /api/control`, add a case before `default`:

```javascript
    case 'loadPreset': {
      const cfg = getPreset(params.presetId);
      if (!cfg) return { ok: false, reason: 'unknown preset' };
      engine.loadConfig(cfg);
      return { ok: true, tick: engine.tick };
    }
```

Note: this `case` returns early, so the post-switch `updateConfig(params)` block is
skipped for preset loads (correct — `loadConfig` already set the full config).

- [ ] **Step 4: Verify manually**

Run: `node src/server.js` in one shell, then in another:

```bash
curl -s localhost:3000/api/presets
curl -s -X POST localhost:3000/api/control -H 'Content-Type: application/json' \
  -d '{"action":"loadPreset","params":{"presetId":"bottleneck"}}'
curl -s -X POST localhost:3000/api/control -H 'Content-Type: application/json' \
  -d '{"action":"loadPreset","params":{"presetId":"nope"}}'
```

Expected: first returns a 3-element JSON array of `{id,label,description}`; second returns `{"ok":true,"tick":0}`; third returns `{"ok":false,"reason":"unknown preset"}`. Stop the server (Ctrl-C) when done.

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat: serve preset metadata and handle loadPreset control action"
```

---

## Task 4: Header simulated-time display

**Files:**
- Modify: `src/public/index.html` (header, line 18)
- Modify: `src/public/app.js` (render loop, after line 491)

- [ ] **Step 1: Add the time span to the header**

In `src/public/index.html`, after line 18 (`<span>Tick: ...</span>`), add:

```html
      <span>Zeit: <strong id="time-counter">0.0</strong> s</span>
```

- [ ] **Step 2: Render seconds in the update loop**

In `src/public/app.js`, immediately after line 491 (`setTextContent('tick-counter', state.tick);`), add:

```javascript
  // Simulated elapsed time in seconds = ticks / ticksPerSecond (independent of the
  // wall-clock speed multiplier). Falls back to 10 tps if the field is absent.
  const tps = state.ticksPerSecond || 10;
  setTextContent('time-counter', (state.tick / tps).toFixed(1));
```

- [ ] **Step 3: Verify manually**

Run: `node src/server.js`, open http://localhost:3000, press Start. Confirm the header shows `Zeit: X.X s` increasing, and that at tick 10 it reads `1.0 s` (default 10 ticks/s). Stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html src/public/app.js
git commit -m "feat: show simulated elapsed time in seconds in the header"
```

---

## Task 5: Scenario preset buttons + toast feedback

**Files:**
- Modify: `src/public/index.html` (controls section ~line 115; toast element)
- Modify: `src/public/app.js` (event wiring, after the reset handlers ~line 1115)
- Modify: `src/public/style.css` (toast styles)

- [ ] **Step 1: Add the scenario controls row and toast element**

In `src/public/index.html`, add a new controls-row right after the Playback controls `</div>` (after line 115):

```html
    <!-- Scenario presets: curated, read-only teaching configs (buttons generated by app.js) -->
    <div class="controls-row" id="preset-row">
      <span class="section-label">Szenarien <span class="info-icon" data-tip="Vorbereitete Beispiel-Szenarien. Nach dem Laden ist die Simulation pausiert — mit Play starten.">i</span></span>
      <!-- Generated by app.js from GET /api/presets -->
    </div>
```

Add the toast element just inside `<body>` — place it right after the opening `<header>`'s closing tag (after line 20, `</header>`):

```html
  <div id="toast" class="toast" hidden></div>
```

- [ ] **Step 2: Add toast styles**

Append to `src/public/style.css`:

```css
/* Transient confirmation toast (e.g. "Preset loaded"). Auto-dismissed by app.js. */
.toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  background: #1f8a4c;
  color: #fff;
  padding: 0.6rem 1.1rem;
  border-radius: 6px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  z-index: 1000;
}
.toast[hidden] { display: none; }
```

- [ ] **Step 3: Add the preset rendering, load handler, and toast helper**

In `src/public/app.js`, after the reset handlers (after line 1115,
`document.getElementById('btn-reset-defaults')...`), add:

```javascript
// ── Scenario presets ────────────────────────────────────────────────────────

// Transient confirmation message. Re-arming clearTimeout avoids a stale earlier
// toast hiding a newer one.
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// Loading a preset swaps the whole machine/buffer set, so we reuse the reset
// flow (rebuild pipeline + sliders from the fresh state) rather than just diffing.
async function loadPreset(presetId, label) {
  const res = await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'loadPreset', params: { presetId } }),
  }).then(r => r.json()).catch(() => ({ ok: false }));

  if (!res.ok) { showToast('⚠ Preset konnte nicht geladen werden'); return; }

  const newState = await fetch('/api/state').then(r => r.json());
  lastState = newState;
  buildPipeline(newState);
  builtMachineKey = newState.machines.map(m => m.id).join(',');
  prevStateForDiff = newState;
  resetParticles();
  buildControlSliders(newState);
  document.getElementById('src-interval').value = newState.source.interval;
  document.getElementById('val-src-interval').textContent = newState.source.interval;
  document.getElementById('material-stock').value = newState.source.materialStock;
  document.getElementById('val-material-stock').textContent = newState.source.materialStock;

  showToast(`✓ Preset „${label}" geladen – jetzt starten`);
}

// Fetch preset metadata once and render a button per scenario.
async function initPresetButtons() {
  const row = document.getElementById('preset-row');
  if (!row) return;
  let presets = [];
  try {
    presets = await fetch('/api/presets').then(r => r.json());
  } catch (_) { return; }
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.label;
    btn.title = p.description;
    btn.dataset.presetId = p.id;
    btn.addEventListener('click', () => loadPreset(p.id, p.label));
    row.appendChild(btn);
  }
}
initPresetButtons();
```

Note on globals: `lastState`, `buildPipeline`, `builtMachineKey`, `prevStateForDiff`,
`resetParticles`, and `buildControlSliders` are the same module-scope names used by the
existing `applyReset` function (around line 1097) — this handler mirrors it deliberately.

- [ ] **Step 4: Verify manually**

Run: `node src/server.js`, open http://localhost:3000.
1. Confirm a "Szenarien" row shows three buttons (Engpass, Ausbalanciert, Materialmangel).
2. Click "Engpass (Montage)" — confirm: a green toast "✓ Preset „Engpass (Montage)" geladen – jetzt starten" appears and auto-hides after ~3s; the pipeline rebuilds; the sim is paused at Tick 0 / Zeit 0.0 s; the start-banner is visible.
3. Press Start and confirm M3 (Montage) becomes the bottleneck (parts pile up in BUF2).
4. Click "Materialmangel (Quelle)", Start, and confirm machines spend most time STARVED.
Stop the server.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (collector, config, engine, entities, presets, sim-status, suggestions-view).

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html src/public/app.js src/public/style.css
git commit -m "feat: scenario preset buttons with load-confirmation toast"
```

---

## Self-Review Notes

- **Spec coverage:** presets.js + 3 scenarios (Task 1); read-only/code-only (server holds configs, Task 1/3); paused-at-tick-0 (`loadConfig`, Task 2); "preset loaded" feedback (toast, Task 5); seconds display (Task 4); `/api/presets` + `loadPreset` (Task 3). All spec sections mapped.
- **Type consistency:** `loadConfig`, `getPreset`, `PRESETS`, `showToast`, `loadPreset`, `initPresetButtons`, `time-counter`, `preset-row`, `toast` ids used identically across HTML/JS/tests.
- **No placeholders:** every code step shows complete content; preset configs use concrete numbers.
