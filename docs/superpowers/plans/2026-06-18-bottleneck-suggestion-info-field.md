# Bottleneck Suggestion Info Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover info icon to each bottleneck suggestion in the banner that explains, in plain German, why the station was flagged (its live utilization vs. the 60% threshold).

**Architecture:** `collector.js` already computes per-station `avgUtil`. Carry `avgUtil`, `threshold`, and a German `reason` string into each suggestion object. The front-end `updateSuggestionBanner()` renders the existing `.info-icon` tooltip pattern using `reason` as the tip, with an `escapeAttr` helper so generated text is safe inside an HTML attribute.

**Tech Stack:** Node.js, vanilla ES modules, `node:test` for tests. No build step.

---

### Task 1: Add `reason`/`avgUtil`/`threshold` to suggestions (collector)

**Files:**
- Modify: `src/metrics/collector.js:111-122`
- Test: `test/collector.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to `test/collector.test.js` (after the existing "multiple saturated stations" test, ~line 54):

```js
test('each suggestion carries a reason with util % and threshold %, plus raw avgUtil', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  const sug = m.suggestions[0];                 // S2 @ 0.95
  assert.equal(typeof sug.reason, 'string');
  assert.match(sug.reason, /95%/);              // this station's utilization
  assert.match(sug.reason, /60%/);              // the threshold
  assert.match(sug.reason, /S2/);               // names the station
  assert.ok(sug.avgUtil > 0.6);
  assert.equal(sug.threshold, 0.6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/collector.test.js`
Expected: FAIL — the new test errors (`sug.reason` is `undefined`, `typeof` is `'undefined'`).

- [ ] **Step 3: Write minimal implementation**

In `src/metrics/collector.js`, change the suggestion loop (lines 111-122) so `avgUtil` is destructured and the new fields are added:

```js
  const suggestions = [];
  for (const { stationId, avgUtil } of bottleneckStations) {
    const stationMachines = machineMetrics.filter(mm => mm.stationId === stationId);
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) continue;
    const rep = stationMachines[0];
    suggestions.push({
      type: 'add-parallel-machine',
      stationId,
      machineId: rep.id,
      avgUtil,
      threshold: BOTTLENECK_UTIL_THRESHOLD,
      label: `${rep.id} (${rep.name}) ist ein Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
      reason: `Erkannt, weil Station ${stationId} mit ${Math.round(avgUtil * 100)}% Auslastung läuft — über der ${Math.round(BOTTLENECK_UTIL_THRESHOLD * 100)}%-Schwelle, ab der eine Maschine als Engpass gilt. Auslastung = Anteil der Zeit, in der aktiv bearbeitet wird (nicht blockiert oder wartend).`,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/collector.test.js`
Expected: PASS — all tests, including the existing single/multi/empty suggestion tests (unchanged behavior) and the new reason test.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/collector.js test/collector.test.js
git commit -m "feat: add reason/avgUtil/threshold to bottleneck suggestions"
```

---

### Task 2: Render the info icon in the suggestion banner (front-end)

**Files:**
- Modify: `src/public/app.js:958-979`

No automated test — vanilla DOM front-end with no test harness. Verified manually in Task 3.

- [ ] **Step 1: Add an `escapeAttr` helper above `updateSuggestionBanner`**

Insert immediately before `function updateSuggestionBanner(metrics) {` (line 958):

```js
// Escape a generated string for safe interpolation into an HTML attribute value.
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Render the info icon using `s.reason`**

In `updateSuggestionBanner`, replace the `.sg-text` line inside the `.map(...)` (line 970):

```js
      `<span class="sg-text">⚠ ${s.label} <span class="info-icon" data-tip="${escapeAttr(s.reason)}">i</span></span>` +
```

(The full template literal otherwise stays the same: `.sg-row` wrapper and `.sg-btn` button unchanged.)

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat: show why-bottleneck info icon on suggestion banner"
```

---

### Task 3: Verify tooltip rendering and adjust CSS if needed

**Files:**
- Possibly modify: `src/public/style.css` (the `.info-icon::after` rule, ~lines 315-374)

- [ ] **Step 1: Run the app and trigger a bottleneck**

Run: `npm start` (or the project's start command — check `package.json` `scripts`).
Open the browser UI, run the simulation, and drive a station above 60% utilization (e.g. raise a machine's cycle time via its slider) until the orange suggestion banner appears.

- [ ] **Step 2: Hover the info icon and inspect**

Hover the "i" icon next to a suggestion. Expected: a tooltip showing the German `reason` text, e.g. "Erkannt, weil Station … mit 95% Auslastung läuft — über der 60%-Schwelle …".

Check: the text is fully visible, wraps onto multiple lines rather than running off-screen, and is not clipped at the viewport edge.

- [ ] **Step 3: Adjust CSS only if it clips**

If — and only if — the tooltip clips or overflows, scope a width/wrap fix to the banner. Add to `src/public/style.css`:

```css
#suggestion-banner .info-icon::after {
  max-width: 280px;
  white-space: normal;
  text-align: left;
}
```

If the existing `.info-icon::after` already wraps and fits, make no CSS change.

- [ ] **Step 4: Commit (only if CSS changed)**

```bash
git add src/public/style.css
git commit -m "style: constrain bottleneck suggestion tooltip width"
```

---

## Self-Review Notes

- **Spec coverage:** collector `reason`/`avgUtil`/`threshold` (Task 1), banner info icon + `escapeAttr` (Task 2), CSS width verification (Task 3), test extension (Task 1) — all spec sections covered.
- **Out of scope** (per spec): SVG badge, table badge, detail-panel label, detection algorithm/threshold — untouched.
- **Type consistency:** `reason` (string), `avgUtil` (number), `threshold` (number) named identically in collector, test, and front-end usage. `escapeAttr` defined in Task 2 before its use.
