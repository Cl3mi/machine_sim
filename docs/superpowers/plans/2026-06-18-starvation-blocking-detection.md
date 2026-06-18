# Starvation/Blocking Bottleneck Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the absolute-utilization bottleneck detector with a flow-based detector that identifies the true constraint(s) using starvation/blocking signals, demoting busy-but-blocked victims.

**Architecture:** All detection logic stays in the pure module `src/metrics/collector.js` (`calculateMetrics(state)`), which already receives machines (with `ticksProcessing/Blocked/Starved/Idle`, `inputBufferId`, `outputBufferId`) and buffers (with `load`, `capacity`). We aggregate per station, walk the linear buffer chain to find each station's downstream station, gate on `busy && !blocked`, rank survivors by a confidence score, and emit suggestions plus a diagnostic note. Three consumers (`prometheus.js`, `opcua/server.js`, `public/app.js`) are updated for the new fields.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`. Run tests with `node --test`.

Spec: `docs/superpowers/specs/2026-06-18-starvation-blocking-detection-design.md`

---

## File Structure

- **Modify** `src/metrics/collector.js` — add constants, per-machine ratio/flow fields, replace detection block (lines 86–125), build suggestions + diagnostic note.
- **Modify** `test/collector.test.js` — upgrade `makeState` fixture (dynamic buffers, `blocked`/`load`/`capacity`), rewrite intent-changed tests, add new tests.
- **Modify** `src/metrics/prometheus.js` — add `plantsim_machine_is_primary_constraint` gauge.
- **Modify** `src/opcua/server.js` — `bottleneckId` = primary constraint.
- **Modify** `src/public/app.js` — render the diagnostic note (no spawn button) and tolerate suggestions without `stationId`.

---

## Task 1: Fixture upgrade + constants + per-machine flow fields

Lays the groundwork: a fixture that can express blocking and buffer fill, the new tuning constants, and the additive per-machine fields (with defaults). Detection still uses the OLD logic after this task — only the per-machine output shape grows. This keeps the task self-contained and green.

**Files:**
- Modify: `test/collector.test.js` (the `makeState` helper, top of file)
- Modify: `src/metrics/collector.js:17-22` (constants), `src/metrics/collector.js:64-84` (per-machine map)

- [ ] **Step 1: Replace the `makeState` helper with a topology-aware version**

In `test/collector.test.js`, replace the existing `makeState` function (lines ~5-26) with:

```js
// Build a minimal state snapshot from machine specs.
// Spec fields: { id, stationId, inputBufferId, outputBufferId?, proc,
//                blocked?, starved?, name? }. Total ticks fixed at 100;
//   starved defaults to (100 - proc - blocked).
// Buffers are derived from the ids the machines reference. Override a buffer's
// capacity/load/wait via `bufferOverrides`, e.g. { BUF1: { load: 3, capacity: 3 } }.
function makeState(machineSpecs, bufferOverrides = {}) {
  const bufferIds = new Set();
  for (const s of machineSpecs) {
    if (s.inputBufferId)  bufferIds.add(s.inputBufferId);
    if (s.outputBufferId) bufferIds.add(s.outputBufferId);
  }
  const buffers = [...bufferIds].map(id => ({
    id,
    capacity:       bufferOverrides[id]?.capacity ?? 4,
    load:           bufferOverrides[id]?.load ?? 0,
    totalWaitTicks: bufferOverrides[id]?.totalWaitTicks ?? 0,
    totalPartsOut:  bufferOverrides[id]?.totalPartsOut ?? 1,
  }));
  return {
    tick: 100,
    machines: machineSpecs.map(s => {
      const proc    = s.proc;
      const blocked = s.blocked ?? 0;
      const starved = s.starved ?? (100 - proc - blocked);
      return {
        id: s.id, stationId: s.stationId, name: s.name ?? s.id,
        inputBufferId: s.inputBufferId, outputBufferId: s.outputBufferId ?? null,
        state: 'PROCESSING', currentPartId: 1, cycleTime: 5, rejectRate: 0,
        ticksProcessing: proc, ticksBlocked: blocked,
        ticksStarved: starved, ticksIdle: 0,
        partsProcessed: proc,
      };
    }),
    buffers,
    sink: { partsReceived: 10, recentParts: [] },
    scrap: { partsReceived: 0 },
  };
}
```

Note: the existing `avgQueueWait` test relies on `BUF1: totalWaitTicks 200/totalPartsOut 10 = 20` and `BUF0: 50/10 = 5`. That test must now pass overrides — it is updated in Task 5.

- [ ] **Step 2: Add the new constants to collector.js**

In `src/metrics/collector.js`, replace the constants block (lines 17-22):

```js
// A station whose average machine utilization exceeds this is "busy" — the
// first gate for being the line's constraint. Tunable.
const BOTTLENECK_UTIL_THRESHOLD = 0.6;
// A station blocked more than this fraction of the time is a *victim* of a
// downstream constraint, not the constraint itself — it fails the second gate.
const BLOCKED_MAX = 0.05;
// A station starved at least this fraction of the time is "starved"; also used
// for the source-starved diagnostic and the STARVED_BY_UPSTREAM classification.
const STARVED_MIN = 0.10;
// Confidence-score weights (sum to 1): utilization, un-blockedness, downstream
// starvation, upstream buffer fill.
const W_UTIL   = 0.4;
const W_BLOCK  = 0.2;
const W_STARVE = 0.2;
const W_FILL   = 0.2;
// Keep in sync with engine MAX_MACHINES_PER_STATION — no point suggesting a
// spawn for a station that is already full.
const MAX_MACHINES_PER_STATION = 4;
```

- [ ] **Step 3: Add per-machine flow fields with defaults**

In `src/metrics/collector.js`, replace the per-machine map body (lines 64-84) with:

```js
  const machineMetrics = machines.map(m => {
    const totalTicks = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
    const utilization  = totalTicks > 0 ? m.ticksProcessing / totalTicks : 0;
    const blockedRatio = totalTicks > 0 ? m.ticksBlocked    / totalTicks : 0;
    const starvedRatio = totalTicks > 0 ? m.ticksStarved    / totalTicks : 0;

    const upstreamBuffer = bufferById[m.inputBufferId] ?? null;
    const avgQueueWait   = upstreamBuffer && upstreamBuffer.totalPartsOut > 0
      ? upstreamBuffer.totalWaitTicks / upstreamBuffer.totalPartsOut
      : 0;

    return {
      id:           m.id,
      stationId:    m.stationId,
      name:         m.name,
      utilization,
      avgQueueWait,
      blockedTime:  m.ticksBlocked,
      starvedTime:  m.ticksStarved,
      blockedRatio,                 // own ratio, 0–1
      starvedRatio,                 // own ratio, 0–1
      currentState: m.state,
      bottleneck:          false,   // filled in by detection below
      flowState:           'BALANCED',
      isPrimaryConstraint: false,
    };
  });
```

`bufferById` is already built at lines 61-62 (`const bufferById = {}; for (const b of buffers) bufferById[b.id] = b;`) — leave it.

- [ ] **Step 4: Run the suite to confirm still green (old detection intact)**

Run: `node --test test/collector.test.js`
Expected: PASS — adding fields and constants does not change the old detection behavior. (The `avgQueueWait` test still passes because Task 1 has not yet changed its fixture call; it uses default buffers with `totalPartsOut: 1`, so update that assertion only in Task 5. If it fails here on the wait value, leave it — it is rewritten in Task 5.) If any OTHER test fails, stop and investigate.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/collector.js test/collector.test.js
git commit -m "refactor: add flow-metric fields and tuning constants to collector"
```

---

## Task 2: Flow-based detection (gates, topology, confidence, flags)

Replaces the old station-utilization flagging with the gated, ranked, topology-aware detector and writes `bottleneck`/`flowState`/`isPrimaryConstraint` onto each machine. Suggestions are handled in Task 3 — for now keep the existing `suggestions` block working by temporarily computing it from the new constraints (shown below), so the file stays runnable.

**Files:**
- Modify: `src/metrics/collector.js:86-125` (the detection + suggestions block)
- Test: `test/collector.test.js`

- [ ] **Step 1: Write failing tests for the new flagging behavior**

Add these tests to `test/collector.test.js`:

```js
test('a busy, un-blocked station is flagged as the constraint', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(b.bottleneck, true);
  assert.equal(b.flowState, 'CONSTRAINT');
  assert.equal(b.isPrimaryConstraint, true);
});

test('a busy-but-blocked station is NOT the constraint (it is a downstream victim)', () => {
  // S1 is busy (90%) but blocked 40% of the time -> victim of S2.
  // S2 is the real constraint: busy and not blocked.
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 55, blocked: 40 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const a = m.machines.find(x => x.id === 'A');
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(a.bottleneck, false);
  assert.equal(a.flowState, 'BLOCKED_BY_DOWNSTREAM');
  assert.equal(b.bottleneck, true);
  assert.equal(b.isPrimaryConstraint, true);
});

test('the last station can be the constraint even with no downstream', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 90, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').bottleneck, true);
});

test('a starved-but-not-busy station is classified STARVED_BY_UPSTREAM', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 95, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 20, blocked: 0, starved: 80 },
  ]);
  const m = calculateMetrics(state);
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(b.bottleneck, false);
  assert.equal(b.flowState, 'STARVED_BY_UPSTREAM');
});

test('two un-blocked busy stations are ranked by confidence, primary = highest', () => {
  // S2 fed by a full BUF1 (upstream backs up) and starves a downstream S3.
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: 'BUF2', proc: 95, blocked: 0 },
    { id: 'C', stationId: 'S3', inputBufferId: 'BUF2', outputBufferId: null,   proc: 30, blocked: 0, starved: 70 },
  ], { BUF1: { load: 3, capacity: 3 } });
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').isPrimaryConstraint, true);
  assert.equal(m.machines.find(x => x.id === 'A').isPrimaryConstraint, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/collector.test.js`
Expected: FAIL — the new tests reference `flowState`/`isPrimaryConstraint` semantics the old detection does not produce (e.g. busy-but-blocked S1 is still flagged by the old util-only rule).

- [ ] **Step 3: Replace the detection + suggestions block**

In `src/metrics/collector.js`, replace lines 86-125 (the `── Bottleneck detection ──` block through the end of the `suggestions` loop) with:

```js
  // ── Bottleneck detection (flow-based: utilization gate + starvation/blocking) ─
  // A station is the *true constraint* when it is busy (high utilization) AND
  // barely blocked — a blocked station is a victim of a downstream constraint.
  // Two confirming flow signals (a starved downstream, a backed-up upstream
  // buffer) raise a confidence score used to rank constraints and pick the
  // primary one. See the design spec referenced in the file header.
  const clamp = (x) => Math.max(0, Math.min(1, x));

  // Aggregate per station (ratios of summed ticks across parallel machines).
  const stationAgg = new Map(); // stationId -> aggregate
  for (const m of machines) {
    const totalTicks = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
    const a = stationAgg.get(m.stationId) ?? {
      stationId: m.stationId, proc: 0, blocked: 0, starved: 0, total: 0,
      inputBufferId: m.inputBufferId, outputBufferId: m.outputBufferId,
    };
    a.proc    += m.ticksProcessing;
    a.blocked += m.ticksBlocked;
    a.starved += m.ticksStarved;
    a.total   += totalTicks;
    stationAgg.set(m.stationId, a);
  }
  for (const a of stationAgg.values()) {
    a.avgUtil      = a.total > 0 ? a.proc    / a.total : 0;
    a.blockedRatio = a.total > 0 ? a.blocked / a.total : 0;
    a.starvedRatio = a.total > 0 ? a.starved / a.total : 0;
    const inBuf = bufferById[a.inputBufferId] ?? null;
    a.inputFill  = inBuf && inBuf.capacity > 0 ? inBuf.load / inBuf.capacity : 0;
  }

  // Topology (linear chain): downstream station = the station whose input
  // buffer is this station's output buffer.
  const stationByInputBuffer = new Map();
  for (const a of stationAgg.values()) stationByInputBuffer.set(a.inputBufferId, a.stationId);
  for (const a of stationAgg.values()) {
    const downId = a.outputBufferId != null ? stationByInputBuffer.get(a.outputBufferId) : undefined;
    a.downstream = downId != null ? stationAgg.get(downId) : null;
  }

  // Gate + confidence score.
  const constraints = [];
  for (const a of stationAgg.values()) {
    const busy       = a.avgUtil > BOTTLENECK_UTIL_THRESHOLD;
    const notBlocked = a.blockedRatio < BLOCKED_MAX;
    a.isConstraint = busy && notBlocked;
    if (!a.isConstraint) continue;
    const starveTerm = a.downstream ? clamp(a.downstream.starvedRatio) : 1;
    a.confidence =
        W_UTIL   * clamp(a.avgUtil)
      + W_BLOCK  * (1 - a.blockedRatio / BLOCKED_MAX)
      + W_STARVE * starveTerm
      + W_FILL   * clamp(a.inputFill);
    constraints.push(a);
  }
  constraints.sort((x, y) => y.confidence - x.confidence);

  const constraintStationIds = new Set(constraints.map(a => a.stationId));
  const primaryStationId     = constraints[0]?.stationId ?? null;

  // Write flags + flowState onto each machine (station-level verdict).
  machineMetrics.forEach(mm => {
    const a = stationAgg.get(mm.stationId);
    mm.bottleneck          = constraintStationIds.has(mm.stationId);
    mm.isPrimaryConstraint = mm.stationId === primaryStationId;
    mm.flowState =
        mm.bottleneck                 ? 'CONSTRAINT'
      : a.blockedRatio >= BLOCKED_MAX  ? 'BLOCKED_BY_DOWNSTREAM'
      : a.starvedRatio >= STARVED_MIN  ? 'STARVED_BY_UPSTREAM'
      :                                  'BALANCED';
  });

  // Source-starved guard: only relevant when NO internal constraint was found.
  const outputBuffers = new Set(
    [...stationAgg.values()].map(a => a.outputBufferId).filter(id => id != null)
  );
  const firstStation = [...stationAgg.values()].find(a => !outputBuffers.has(a.inputBufferId)) ?? null;
  const sourceStarved = firstStation != null && firstStation.starvedRatio >= STARVED_MIN;
  const anyBusy = [...stationAgg.values()].some(a => a.avgUtil > BOTTLENECK_UTIL_THRESHOLD);

  // Suggestions: one spawn per constraint with room, ranked by confidence.
  // (Reason text + diagnostic note are finished in Task 3.)
  const suggestions = [];
  for (const a of constraints) {
    const stationMachines = machineMetrics.filter(mm => mm.stationId === a.stationId);
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) continue;
    const rep = stationMachines[0];
    suggestions.push({
      type: 'add-parallel-machine',
      stationId: a.stationId,
      machineId: rep.id,
      avgUtil: a.avgUtil,
      threshold: BOTTLENECK_UTIL_THRESHOLD,
      confidence: Math.round(a.confidence * 100) / 100,
      flowState: 'CONSTRAINT',
      label: `${rep.id} (${rep.name}) ist der Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
      reason: `Erkannt, weil Station ${a.stationId} mit ${Math.round(a.avgUtil * 100)}% Auslastung läuft und kaum blockiert ist.`,
    });
  }
```

`firstStation`, `sourceStarved`, and `anyBusy` are computed here but only consumed by the diagnostic note in Task 3 — that is intentional; leave them.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `node --test test/collector.test.js`
Expected: the five Task-2 tests PASS. Some OLD tests (`multiple saturated...`, `empty suggestions...`, `avgQueueWait...`) may now FAIL — they encode the old behavior and are rewritten in Tasks 3 and 5. That is expected; do not "fix" the implementation to satisfy them.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/collector.js test/collector.test.js
git commit -m "feat: flow-based bottleneck detection (gates + confidence + flowState)"
```

---

## Task 3: Confidence ordering, reason text, and the diagnostic note

Finalizes suggestion ordering/reason and adds the `no-internal-constraint` diagnostic note. Also rewrites the existing suggestion-oriented tests to the new behavior.

**Files:**
- Modify: `src/metrics/collector.js` (the suggestions block from Task 2)
- Test: `test/collector.test.js`

- [ ] **Step 1: Write/own the failing tests for suggestions + note**

Delete these original tests (their behavior is superseded) and add the block below in their place:
- `'multiple saturated stations are all flagged, suggested worst-first'`
- `'each suggestion carries a reason with util % and threshold %, plus raw avgUtil'` (the new reason text intentionally no longer embeds the threshold `60%`, so its `/60%/` assertion is obsolete)
- `'empty suggestions when no station exceeds the utilization threshold'`
- `'saturated station at the cap is flagged but yields no suggestion'`

Add:

```js
test('multiple un-blocked constraints are suggested highest-confidence first', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.suggestions.length, 2);
  // S2 (0.95, last station => full starve term) outranks S1 (0.70).
  assert.deepEqual(m.suggestions.map(s => s.stationId), ['S2', 'S1']);
  assert.ok(m.suggestions[0].confidence >= m.suggestions[1].confidence);
  assert.equal(m.suggestions[0].flowState, 'CONSTRAINT');
});

test('a source-starved line yields no bottleneck and a diagnostic note', () => {
  // Both stations idle-ish and the first station is starved (source not feeding).
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 20, blocked: 0, starved: 80 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 25, blocked: 0, starved: 75 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.every(x => x.bottleneck === false));
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'no-internal-constraint');
  assert.equal(m.suggestions[0].machineId, undefined);
});

test('an everything-blocked line yields a diagnostic note', () => {
  // S1 busy but fully blocked (victim), S2 also busy but blocked -> no constraint.
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 65, blocked: 35 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 65, blocked: 35 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.every(x => x.bottleneck === false));
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'no-internal-constraint');
});

test('a constraint at the machine cap is flagged but yields no spawn suggestion', () => {
  const state = makeState([
    { id: 'A',  stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B',  stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bb', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bc', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bd', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.find(x => x.id === 'B').bottleneck);
  assert.deepEqual(m.suggestions, []); // constraint exists (so no note) but is at cap (so no spawn)
});

test('each spawn suggestion carries confidence, threshold, and a flow-aware reason', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const sug = m.suggestions[0];
  assert.equal(sug.threshold, 0.6);
  assert.equal(typeof sug.confidence, 'number');
  assert.match(sug.reason, /S2/);
  assert.match(sug.reason, /95%/);            // utilization
  assert.match(sug.reason, /blockiert/);       // mentions the not-blocked signal
});
```

- [ ] **Step 2: Run to verify the note tests fail**

Run: `node --test test/collector.test.js`
Expected: the `no-internal-constraint` tests FAIL (no note emitted yet); the reason test FAILS on `/blockiert/`.

- [ ] **Step 3: Enrich the reason text and append the diagnostic note**

In `src/metrics/collector.js`, replace the `reason:` line inside the suggestions loop with a flow-aware reason, and append the note after the loop. The loop's `reason` becomes:

```js
      reason: (() => {
        const util  = Math.round(a.avgUtil * 100);
        const block = Math.round(a.blockedRatio * 100);
        const fill  = Math.round(a.inputFill * 100);
        const downClause = a.downstream
          ? ` und die nachgelagerte Station wartet (${Math.round(a.downstream.starvedRatio * 100)}% Leerlauf)`
          : ' (letzte Station der Linie)';
        return `Erkannt, weil Station ${a.stationId} der Engpass ist: ${util}% Auslastung, `
             + `nur ${block}% blockiert${downClause} — Teile stauen sich davor `
             + `(Eingangspuffer ${fill}% voll). Ein blockierter Standort wäre dagegen `
             + `nur Opfer eines nachgelagerten Engpasses.`;
      })(),
```

Then, immediately after the `for (const a of constraints) { ... }` loop, add:

```js
  // Diagnostic note: no internal constraint, but the line is supply-limited or
  // everything is blocked. Emitted only when no station passed the gates.
  if (constraints.length === 0 && (sourceStarved || anyBusy)) {
    suggestions.push({
      type: 'no-internal-constraint',
      reason: 'Kein interner Engpass — die Linie wird von der Quelle / der '
            + 'Ankunftsrate begrenzt (oder staut sich an einem nachgelagerten '
            + 'Engpass zurück).',
    });
  }
```

- [ ] **Step 4: Run to verify all Task-3 tests pass**

Run: `node --test test/collector.test.js`
Expected: all Task-3 tests PASS. (The `avgQueueWait` test is still on the old fixture and is fixed in Task 5; the single-saturated and reason tests from the original suite may need the Task-5 cleanup too. If only `avgQueueWait` fails here, proceed.)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/collector.js test/collector.test.js
git commit -m "feat: confidence-ordered suggestions, flow reason text, diagnostic note"
```

---

## Task 4: Update Prometheus + OPC-UA consumers

Surface the primary constraint and keep `is_bottleneck` semantics consistent (fewer 1s now). Non-breaking: existing series remain.

**Files:**
- Modify: `src/metrics/prometheus.js` (gauge definition near line 83; loop near line 123)
- Modify: `src/opcua/server.js:114-115`

- [ ] **Step 1: Add the primary-constraint gauge definition**

In `src/metrics/prometheus.js`, immediately after the `gMachineBottleneck` gauge definition (the block ending around line 86), add:

```js
const gMachinePrimaryConstraint = new client.Gauge({
  name: 'plantsim_machine_is_primary_constraint',
  help: '1 if this machine is the single primary constraint (highest-confidence bottleneck), 0 otherwise',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});
```

Match the exact `client`/`register` references used by the neighboring gauges (copy the trailing options object from `gMachineBottleneck`).

- [ ] **Step 2: Set the gauge in the per-machine loop**

In `src/metrics/prometheus.js`, inside the `for (const machine of m.machines)` loop, immediately after the `gMachineBottleneck.set(...)` line (around line 129), add:

```js
    gMachinePrimaryConstraint.set(labels, machine.isPrimaryConstraint ? 1 : 0);
```

If there is a "clear series" reset section above the loop (around line 116) that calls `.reset()` on each per-machine gauge, add `gMachinePrimaryConstraint.reset();` there too, mirroring `gMachineBottleneck.reset();`.

- [ ] **Step 3: Point OPC-UA bottleneckId at the primary constraint**

In `src/opcua/server.js`, replace lines 114-115:

```js
  const bottleneck = metrics.machines.find((m) => m.isPrimaryConstraint)
                  ?? metrics.machines.find((m) => m.bottleneck);
  vars.sim.bottleneckId.setValueFromSource(new Variant({ dataType: DataType.String, value: bottleneck?.id ?? '' }));
```

- [ ] **Step 4: Smoke-test the metrics module loads and renders**

Run: `node -e "import('./src/metrics/prometheus.js').then(m => console.log(Object.keys(m))).catch(e => { console.error(e); process.exit(1); })"`
Expected: prints the module's exports with no throw. (If prometheus.js needs the registry initialized differently, instead run the existing app smoke path: `node --test` for any prometheus test, or `node -e "import('./src/metrics/prometheus.js')"` to confirm no syntax/ref error.)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/prometheus.js src/opcua/server.js
git commit -m "feat: expose primary-constraint via Prometheus gauge and OPC-UA bottleneckId"
```

---

## Task 5: Frontend — diagnostic note + remaining test cleanup

The suggestion banner currently always renders a spawn button using `s.stationId`. The new `no-internal-constraint` note has no `stationId`, so the banner must branch. Also finish updating the two original tests still on old expectations.

**Files:**
- Modify: `src/public/app.js:977-989` (the `updateSuggestionBanner` `.map(...)`)
- Test: `test/collector.test.js` (the `avgQueueWait` and `single saturated` originals)

- [ ] **Step 1: Update the remaining original tests**

In `test/collector.test.js`:

Replace the `avgQueueWait` test with a version that supplies buffer wait overrides:

```js
test('avgQueueWait uses the machine input buffer', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ], {
    BUF0: { totalWaitTicks: 50,  totalPartsOut: 10 },
    BUF1: { totalWaitTicks: 200, totalPartsOut: 10 },
  });
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').avgQueueWait, 20); // 200/10
  assert.equal(m.machines.find(x => x.id === 'A').avgQueueWait, 5);  // 50/10
});
```

Confirm the original `'a single saturated station is flagged and gets one suggestion'` test still passes as-is (machine B is busy + not-blocked → constraint; A at 30% → not flagged). If its fixture omits `blocked`, that is fine (`blocked` defaults to 0). Leave it unchanged if green.

- [ ] **Step 2: Run the full collector suite — expect all green**

Run: `node --test test/collector.test.js`
Expected: PASS, all tests. If any fail, fix the test fixture/assertion (not the implementation) to match the designed behavior.

- [ ] **Step 3: Branch the suggestion banner on note vs spawn**

In `src/public/app.js`, replace the `banner.innerHTML = suggestions.map(...)` block (lines ~977-983) with:

```js
  banner.innerHTML = suggestions.map((s, i) => {
    if (s.type === 'no-internal-constraint') {
      return `<div class="sg-row sg-note">` +
        `<span class="sg-text">ℹ ${s.reason}</span>` +
      `</div>`;
    }
    return `<div class="sg-row">` +
      `<span class="sg-text">⚠ ${s.label} <span class="info-icon" data-tip="${escapeAttr(s.reason)}">i</span></span>` +
      `<button class="sg-btn" data-station="${s.stationId}" data-idx="${i}" type="button">+ Parallele Maschine hinzufügen</button>` +
    `</div>`;
  }).join('');
```

The existing `banner.querySelectorAll('.sg-btn').forEach(...)` wiring below stays unchanged — the note row has no `.sg-btn`, so it is simply skipped.

- [ ] **Step 4: Verify the frontend renders both cases**

This is a browser file with no unit test. Use the `run` skill (or `node --check`) to confirm no syntax error and eyeball the banner:

Run: `node --check src/public/app.js`
Expected: no output (syntax OK). Then, if launching the app, drive the sim into (a) a clear single bottleneck — banner shows the ⚠ spawn row, and (b) a starved/idle start — banner shows the ℹ note row with no button.

- [ ] **Step 5: Commit**

```bash
git add src/public/app.js test/collector.test.js
git commit -m "feat: render no-internal-constraint note in suggestion banner; finalize tests"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the entire test suite**

Run: `node --test`
Expected: PASS, no failures across all test files.

- [ ] **Step 2: Confirm no stray references to removed behavior**

Run: `grep -rn "BOTTLENECK_UTIL_THRESHOLD\|isPrimaryConstraint\|flowState\|no-internal-constraint" src/ test/`
Expected: references appear only in `collector.js`, `prometheus.js`, `opcua/server.js`, `app.js`, and the tests — and the constants/fields are spelled consistently everywhere (no `flowstate`/`primaryConstraint` typos).

- [ ] **Step 3: Final commit if anything was touched**

```bash
git add -A
git commit -m "test: full-suite verification for flow-based bottleneck detection" || echo "nothing to commit"
```
