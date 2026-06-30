# Multi-bottleneck, Per-machine Quality Gate, Grouped Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect multiple bottleneck stations at once, make the quality gate configurable per machine (several gates allowed), and keep parallel machines grouped together in the cycle-time sliders and machine table.

**Architecture:** `collector.js` (pure function) changes from picking one bottleneck station to flagging every station above the utilization threshold and returning a `suggestions` array. The front-end (`app.js`, `index.html`) renders all suggestions, moves the reject-rate control into the per-machine detail panel, and sorts machines by pipeline station order so parallels stay together.

**Tech Stack:** Node.js ESM, `node:test` (built-in test runner), Fastify, vanilla ES-module front-end (no build step), SVG.

**Design doc:** `docs/superpowers/specs/2026-06-17-multi-bottleneck-quality-gate-sorting-design.md`

**How to run the app for manual verification:** `npm start` then open `http://localhost:3000`. Stop with Ctrl-C.
**How to run tests:** `npm test` (runs `node --test`).

---

### Task 1: Update collector tests for multi-bottleneck + `suggestions` array

**Files:**
- Test: `test/collector.test.js`

This task rewrites the bottleneck-related assertions to expect the new behavior (TDD — these will fail against the current `collector.js`). The `makeState` helper and the `avgQueueWait` test are unchanged.

- [ ] **Step 1: Replace the four bottleneck/suggestion tests with the new ones**

In `test/collector.test.js`, replace the block of tests from
`test('bottleneck is the busiest station ...` through the end of
`test('no suggestion when the bottleneck station is already at the cap', ...`
(the test `avgQueueWait uses the machine input buffer` stays as the last test)
with exactly this:

```js
test('a single saturated station is flagged and gets one suggestion', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').bottleneck, true);
  assert.equal(m.machines.find(x => x.id === 'A').bottleneck, false);
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'add-parallel-machine');
  assert.equal(m.suggestions[0].stationId, 'S2');
  assert.equal(m.suggestions[0].machineId, 'B');
  assert.match(m.suggestions[0].label, /B/);
});

test('multiple saturated stations are all flagged, suggested worst-first', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  // Both stations exceed the 0.6 threshold (0.70 and 0.95).
  assert.equal(m.machines.find(x => x.id === 'A').bottleneck, true);
  assert.equal(m.machines.find(x => x.id === 'B').bottleneck, true);
  // Two suggestions, busiest station (S2, 0.95) first.
  assert.equal(m.suggestions.length, 2);
  assert.deepEqual(m.suggestions.map(s => s.stationId), ['S2', 'S1']);
});

test('empty suggestions when no station exceeds the utilization threshold', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 20 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 25 },
  ]);
  const m = calculateMetrics(state);
  assert.deepEqual(m.suggestions, []);
  assert.ok(m.machines.every(x => x.bottleneck === false));
});

test('saturated station at the cap is flagged but yields no suggestion', () => {
  const state = makeState([
    { id: 'A',  stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B',  stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bb', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bc', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bd', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.find(x => x.id === 'B').bottleneck);
  assert.deepEqual(m.suggestions, []);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — the new tests reference `m.suggestions`, which is `undefined`
on the current `collector.js` (e.g. `Cannot read properties of undefined
(reading 'length')` or `deepEqual` mismatch). The `avgQueueWait` test still passes.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/collector.test.js
git commit -m "test: expect multi-bottleneck flagging and suggestions array"
```

---

### Task 2: Implement multi-bottleneck detection in collector.js

**Files:**
- Modify: `src/metrics/collector.js:86-126` (bottleneck section) and the return object at `src/metrics/collector.js:136-145`

- [ ] **Step 1: Replace the bottleneck-detection block**

In `src/metrics/collector.js`, replace the entire block from the comment
`// ── Bottleneck detection (station-level, utilization-based) ──` down to and
including the closing brace of the `if (bottleneckStationId != null ...)` block
(currently lines 86–126) with:

```js
  // ── Bottleneck detection (station-level, utilization-based) ─────────────────
  // Every station whose average machine utilization exceeds the threshold is a
  // bottleneck — there can be several at once. (The previous heuristic flagged
  // only the single busiest station.) Adding a parallel machine lowers a
  // station's per-machine utilization, so a flagged bottleneck clears — the
  // intended teaching feedback. Each flagged station that still has room yields
  // one spawn suggestion; suggestions are ordered worst-utilization-first.
  const stationStats = new Map();   // stationId -> { utilSum, count }
  machineMetrics.forEach(mm => {
    const s = stationStats.get(mm.stationId) ?? { utilSum: 0, count: 0 };
    s.utilSum += mm.utilization;
    s.count   += 1;
    stationStats.set(mm.stationId, s);
  });

  const bottleneckStations = [...stationStats.entries()]
    .map(([stationId, s]) => ({ stationId, avgUtil: s.count > 0 ? s.utilSum / s.count : 0 }))
    .filter(s => s.avgUtil > BOTTLENECK_UTIL_THRESHOLD)
    .sort((a, b) => b.avgUtil - a.avgUtil);

  const bottleneckStationIds = new Set(bottleneckStations.map(s => s.stationId));
  machineMetrics.forEach(mm => {
    if (bottleneckStationIds.has(mm.stationId)) mm.bottleneck = true;
  });

  const suggestions = [];
  for (const { stationId } of bottleneckStations) {
    const stationMachines = machineMetrics.filter(mm => mm.stationId === stationId);
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) continue;
    const rep = stationMachines[0];
    suggestions.push({
      type: 'add-parallel-machine',
      stationId,
      machineId: rep.id,
      label: `${rep.id} (${rep.name}) ist ein Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
    });
  }
```

- [ ] **Step 2: Update the return object**

In the `return { ... }` at the bottom of `calculateMetrics`, replace the line
`    suggestion,` with:

```js
    suggestions,
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all collector tests (including `avgQueueWait`) green.

- [ ] **Step 4: Commit**

```bash
git add src/metrics/collector.js
git commit -m "feat: flag all saturated stations as bottlenecks, return suggestions array"
```

---

### Task 3: Render all suggestions in the banner

**Files:**
- Modify: `src/public/app.js:945-961` (`updateSuggestionBanner`)

The current banner reads the singular `metrics.suggestion` and renders one row.
Update it to iterate `metrics.suggestions`.

- [ ] **Step 1: Replace `updateSuggestionBanner`**

In `src/public/app.js`, replace the whole `updateSuggestionBanner` function with:

```js
function updateSuggestionBanner(metrics) {
  const banner = document.getElementById('suggestion-banner');
  if (!banner) return;
  const suggestions = metrics?.suggestions ?? [];
  if (suggestions.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = suggestions.map((s, i) =>
    `<div class="sg-row">` +
      `<span class="sg-text">⚠ ${s.label}</span>` +
      `<button class="sg-btn" data-station="${s.stationId}" data-idx="${i}" type="button">+ Parallele Maschine hinzufügen</button>` +
    `</div>`
  ).join('');
  banner.querySelectorAll('.sg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      postControl({ stationId: btn.dataset.station }, 'spawnMachine');
    });
  });
}
```

- [ ] **Step 2: Manually verify**

Run: `npm start`, open `http://localhost:3000`, press Play.
Expected: With default config the banner shows the Montage (M3) suggestion. To
force multiple bottlenecks, drag several cycle-time sliders up (e.g. M1 and M3
to 12+) — the banner should list a row per saturated station, each with its own
"+ Parallele Maschine hinzufügen" button that spawns into the correct station.
Stop the app with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat: render one suggestion row per bottleneck station"
```

---

### Task 4: Per-machine quality gate in the detail panel

**Files:**
- Modify: `src/public/index.html:145-152` (remove global quality-gate row), `src/public/index.html:71-74` (detail-panel reject stat → editable)
- Modify: `src/public/app.js` — `updateMachineDetail` (`~617-694`), `applyReset` (`~1029-1048`), reject-rate input handler (`~1088-1092`), `updatePipeline` scrap label (`~477-480`)

- [ ] **Step 1: Remove the global quality-gate control row from index.html**

In `src/public/index.html`, delete this entire block (currently lines 145–152):

```html
    <!-- Quality gate -->
    <div class="controls-row">
      <span class="section-label">Quality Gate (M2)</span>
      <div class="slider-group">
        <label>Reject rate <span class="info-icon" data-tip="Anteil der Teile, die M2 bei der Qualitätsprüfung ausscheidet.">i</span><span id="val-reject-rate">10%</span></label>
        <input type="range" id="reject-rate" min="0" max="50" step="1" value="10" />
      </div>
    </div>
```

- [ ] **Step 2: Make the detail-panel reject stat an editable control**

In `src/public/index.html`, replace the read-only reject stat (currently lines 71–74):

```html
        <div class="md-stat" id="md-reject-stat" hidden>
          <div class="md-stat-label">Reject rate</div>
          <div class="md-stat-value" id="md-reject">0%</div>
        </div>
```

with an editable slider that is always shown (it controls whether the machine is
a quality gate):

```html
        <div class="md-stat md-stat-gate" id="md-reject-stat">
          <div class="md-stat-label">Reject rate (Quality Gate) <span id="md-reject-val">0%</span></div>
          <input type="range" id="md-reject-slider" min="0" max="50" step="1" value="0" />
        </div>
```

- [ ] **Step 3: Wire the detail-panel slider in app.js**

In `src/public/app.js`, in `updateMachineDetail`, replace the existing reject
block (currently lines 663–672):

```js
  // Reject rate only meaningful for the quality gate (M2 or any non-zero)
  const rejectStat = document.getElementById('md-reject-stat');
  if (rejectStat) {
    if (m.rejectRate && m.rejectRate > 0) {
      rejectStat.hidden = false;
      setTextContent('md-reject', (m.rejectRate * 100).toFixed(0) + '%');
    } else {
      rejectStat.hidden = true;
    }
  }
```

with this (the slider is always shown and reflects the machine's current rate,
unless the user is actively dragging it):

```js
  // Quality gate: editable reject-rate slider, shown for every machine.
  const rejectSlider = document.getElementById('md-reject-slider');
  const rejectValEl  = document.getElementById('md-reject-val');
  const pct = Math.round((m.rejectRate ?? 0) * 100);
  if (rejectValEl) rejectValEl.textContent = pct + '%';
  if (rejectSlider && document.activeElement !== rejectSlider) {
    rejectSlider.value = pct;
  }
```

- [ ] **Step 4: Add the slider's input handler in app.js**

In `src/public/app.js`, in `openMachineDetail`, add a one-time listener wired to
the currently selected machine. Replace the body of `openMachineDetail`
(currently lines 591–603) with:

```js
function openMachineDetail(id) {
  selectedMachineId = id;
  const panel = document.getElementById('machine-detail');
  if (panel) panel.hidden = false;

  // Wire the reject-rate slider once; it always targets the selected machine.
  const rejectSlider = document.getElementById('md-reject-slider');
  if (rejectSlider && !rejectSlider.dataset.wired) {
    rejectSlider.dataset.wired = '1';
    rejectSlider.addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      const valEl = document.getElementById('md-reject-val');
      if (valEl) valEl.textContent = v + '%';
      if (selectedMachineId) postControl({ machineId: selectedMachineId, rejectRate: v / 100 });
    });
  }

  // Push an immediate render so the panel populates before the next SSE frame
  updateMachineDetail();
  if (lastState) {
    // Re-run machine rect update so the selection ring appears immediately
    const metricsMap = {};
    if (lastMetrics?.machines) for (const m of lastMetrics.machines) metricsMap[m.id] = m;
    for (const m of lastState.machines) updateMachine(m, metricsMap[m.id]);
  }
}
```

- [ ] **Step 5: Remove the global reject-rate input handler in app.js**

In `src/public/app.js`, delete this handler (currently lines 1088–1092), which
targeted the now-removed global `#reject-rate` input:

```js
document.getElementById('reject-rate').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('val-reject-rate').textContent = v + '%';
  postControl({ machineId: 'M2', rejectRate: v / 100 });
});
```

- [ ] **Step 6: Remove the M2 reject block from `applyReset` in app.js**

In `src/public/app.js`, in `applyReset`, delete this block (currently lines 1042–1047):

```js
  const m2 = newState.machines.find(m => m.id === 'M2');
  if (m2) {
    const pct = Math.round(m2.rejectRate * 100);
    document.getElementById('reject-rate').value = pct;
    document.getElementById('val-reject-rate').textContent = pct + '%';
  }
```

- [ ] **Step 7: Blank the single scrap-rate label in `updatePipeline`**

In `src/public/app.js`, in `updatePipeline`, replace this block (currently lines 477–480):

```js
  const rejectMachine = state.machines.find(m => m.rejectRate > 0);
  if (rejectMachine) {
    setTextContent('scrap-rate-label', (rejectMachine.rejectRate * 100).toFixed(0) + '%');
  }
```

with (per-gate rates now live in each machine's panel, so the single label above
the shared scrap sink is no longer meaningful):

```js
  // Per-machine reject rates are shown in each machine's detail panel; the
  // shared scrap sink no longer carries a single rate label.
  setTextContent('scrap-rate-label', '');
```

- [ ] **Step 8: Manually verify**

Run: `npm start`, open `http://localhost:3000`, press Play.
Expected:
- The control panel no longer has a "Quality Gate (M2)" row.
- Clicking M2 shows a "Reject rate (Quality Gate)" slider at 10%; dragging it
  changes the scrap rate (watch the Scrapped Parts metric / scrap particles).
- Clicking a different machine (e.g. M1) shows its slider at 0%; raising it
  makes M1 reject parts too — a second scrap stream appears, confirming
  multiple coexisting gates.
- Reset and Reset-to-Defaults work without console errors.
Stop the app with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add src/public/index.html src/public/app.js
git commit -m "feat: per-machine quality gate in detail panel, drop global M2 slider"
```

---

### Task 5: Group parallel machines in sliders and table

**Files:**
- Modify: `src/public/app.js` — add `orderedMachines` helper; use it in `buildControlSliders` (`~973`) and `updateMetricsDashboard` (`~730`)

- [ ] **Step 1: Add the `orderedMachines` helper**

In `src/public/app.js`, add this function just above `function buildControlSliders(state) {`
(currently near line 965):

```js
// Group machines by station in pipeline (first-appearance) order, sorted within
// a station by id, so parallel machines (M3, M3b, M3c) stay together instead of
// appearing in raw config order (where spawns are appended after later stations).
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

- [ ] **Step 2: Use it for the cycle-time sliders**

In `src/public/app.js`, in `buildControlSliders`, change the machine loop header
from:

```js
  for (const m of state.machines) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${m.id} cycle time <span id="val-ct-${m.id}">${m.cycleTime}</span></label>
```

to:

```js
  for (const m of orderedMachines(state.machines)) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${m.id} cycle time <span id="val-ct-${m.id}">${m.cycleTime}</span></label>
```

- [ ] **Step 3: Use it for the machine table**

In `src/public/app.js`, in `updateMetricsDashboard`, change:

```js
  for (const m of metrics.machines) {
    const tr = document.createElement('tr');
```

to:

```js
  for (const m of orderedMachines(metrics.machines)) {
    const tr = document.createElement('tr');
```

- [ ] **Step 4: Manually verify**

Run: `npm start`, open `http://localhost:3000`, press Play. Click M3 and press
"+ Parallele Maschine" (or use a banner button) to spawn `M3b`.
Expected: In both the "Machine Cycle Times" control row and the dashboard
machine table, the order is `M1, M2, M3, M3b, M4` — `M3b` sits directly after
`M3`, never after `M4`, and no other station appears between `M3` and `M3b`.
Stop the app with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add src/public/app.js
git commit -m "feat: group parallel machines by station order in sliders and table"
```

---

## Self-Review notes

- **Spec coverage:** Task 1–2 → multi-bottleneck + `suggestions` array (spec §1). Task 3 → banner renders all (spec §2). Task 4 → per-machine quality gate, remove global slider, blank scrap label (spec §3). Task 5 → grouped sorting in both places (spec §4). Testing section → Task 1 (TDD on collector); front-end manual verification steps included.
- **Compatibility:** `prometheus.js` and `opcua/server.js` read only the per-machine `bottleneck` boolean (unchanged shape) and `metrics.machines.find(m => m.bottleneck)` — both keep working with multiple flagged machines; neither reads `suggestion`/`suggestions`, so no change needed there.
- **Type consistency:** `suggestions` (array of `{type, stationId, machineId, label}`) is produced in Task 2 and consumed in Task 3. `orderedMachines(machines)` defined and used consistently in Task 5. Detail-panel ids (`md-reject-slider`, `md-reject-val`, `md-reject-stat`) match between Task 4 HTML and JS steps.
