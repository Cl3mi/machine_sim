# Spawnable Parallel Machines + Bottleneck Suggestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students add/remove parallel machines at a station to relieve a bottleneck, and make bottleneck detection suggest spawning one additional machine at the constraining station.

**Architecture:** Each machine becomes self-describing with `stationId`, `inputBufferId`, `outputBufferId` (replacing the engine's positional `machines[i]↔buffers[i]` arithmetic). A station is the set of machines sharing a `stationId` and therefore the same input/output buffer. The engine processes machines downstream→upstream by a station `order` derived from a one-time buffer-graph walk. Bottleneck detection becomes utilization-based at the station level and emits a `suggestion`. The frontend computes its SVG layout from state (stacking parallel machines vertically) instead of hardcoded coordinates.

**Tech Stack:** Node.js ESM, Fastify, vanilla SVG/JS frontend, `node:test` (built-in) for unit tests (no new dependency).

**Reference spec:** `docs/superpowers/specs/2026-06-17-spawnable-machines-design.md`

---

## File Structure

- `package.json` — add `"test": "node --test"` script.
- `src/simulation/config.js` — add `stationId`/`inputBufferId`/`outputBufferId` to each default machine.
- `src/simulation/entities.js` — `Machine` carries the new wiring fields.
- `src/simulation/engine.js` — station-order processing, id-based buffer lookups, `spawnMachine`, `removeMachine`, extended `getState`.
- `src/metrics/collector.js` — `avgQueueWait` by `inputBufferId`, utilization-based station bottleneck, `suggestion` field.
- `src/server.js` — `spawnMachine` / `removeMachine` control actions.
- `src/public/app.js` — data-driven layout, generic connectors/transfers, suggestion banner, station +/- controls.
- `src/public/index.html` — suggestion banner element + machine-detail station controls.
- `src/public/style.css` — banner + station-control styles.
- `test/engine.test.js` (Create) — engine spawn/remove/ordering tests.
- `test/collector.test.js` (Create) — bottleneck + suggestion tests.

---

## Task 1: Test harness + config wiring fields

**Files:**
- Modify: `package.json:7-10`
- Modify: `src/simulation/config.js:19-32`
- Create: `test/config.test.js`

- [ ] **Step 1: Add the test script**

Edit `package.json` scripts block to:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';

test('every default machine declares station + buffer wiring', () => {
  for (const m of DEFAULT_CONFIG.machines) {
    assert.ok(m.stationId, `${m.id} missing stationId`);
    assert.ok(m.inputBufferId, `${m.id} missing inputBufferId`);
    assert.ok('outputBufferId' in m, `${m.id} missing outputBufferId`);
  }
  const last = DEFAULT_CONFIG.machines.at(-1);
  assert.equal(last.outputBufferId, null, 'last machine outputs to Sink (null)');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `M1 missing stationId`.

- [ ] **Step 4: Add wiring fields to config**

Replace the `machines` array in `src/simulation/config.js` (lines 19-24) with:

```js
  // Machines: each declares its station and the buffers it pulls from / pushes to.
  // outputBufferId:null means the machine pushes finished parts to the Sink.
  machines: [
    { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',    cycleTime: 4,                  inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
    { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung',  cycleTime: 3, rejectRate: 0.10, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
    { id: 'M3', stationId: 'S3', name: 'Montage',           cycleTime: 15,                 inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
    { id: 'M4', stationId: 'S4', name: 'Verpackung',        cycleTime: 2,                  inputBufferId: 'BUF3', outputBufferId: null   },
  ],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/simulation/config.js test/config.test.js
git commit -m "feat: add station + buffer wiring to machine config; add node:test harness"
```

---

## Task 2: Machine entity carries wiring fields

**Files:**
- Modify: `src/simulation/entities.js:58-78`
- Create: `test/entities.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/entities.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, MachineState } from '../src/simulation/entities.js';

test('Machine exposes station + buffer wiring from config', () => {
  const m = new Machine({
    id: 'M3', stationId: 'S3', name: 'Montage', cycleTime: 15,
    inputBufferId: 'BUF2', outputBufferId: 'BUF3',
  });
  assert.equal(m.stationId, 'S3');
  assert.equal(m.inputBufferId, 'BUF2');
  assert.equal(m.outputBufferId, 'BUF3');
  assert.equal(m.state, MachineState.IDLE);
});

test('Machine outputBufferId may be null (Sink)', () => {
  const m = new Machine({ id: 'M4', stationId: 'S4', name: 'V', cycleTime: 2,
    inputBufferId: 'BUF3', outputBufferId: null });
  assert.equal(m.outputBufferId, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/entities.test.js`
Expected: FAIL — `m.stationId` is `undefined`.

- [ ] **Step 3: Add fields to the Machine constructor**

In `src/simulation/entities.js`, inside the `Machine` constructor, after the `this.rejectRate` line (currently line 63) insert:

```js
    this.stationId      = cfg.stationId;
    this.inputBufferId  = cfg.inputBufferId;
    this.outputBufferId = cfg.outputBufferId ?? null;   // null ⇒ pushes to Sink
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/entities.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/entities.js test/entities.test.js
git commit -m "feat: Machine entity carries stationId + buffer wiring"
```

---

## Task 3: Engine — id-based wiring + station-order processing (refactor)

Replace positional buffer arithmetic with `inputBufferId`/`outputBufferId` lookups and a station `order` derived from a buffer-graph walk. Behavior for the default linear line must be unchanged (regression).

**Files:**
- Modify: `src/simulation/engine.js` (`_reset`, `_tick`, `_advanceMachine`, `_tryPushDownstream`, `getState`)
- Create: `test/engine.test.js`

- [ ] **Step 1: Write the failing regression + ordering tests**

Create `test/engine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../src/simulation/engine.js';

// A deterministic 2-station line with no rejects: Source→BUF0→S1→BUF1→S2→Sink.
function twoStationConfig(s1Cycle = 2, s2Cycle = 6) {
  return {
    ticksPerSecond: 10,
    source: { interval: 1, materialStock: -1 },
    machines: [
      { id: 'A', stationId: 'S1', name: 'A', cycleTime: s1Cycle, inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
      { id: 'B', stationId: 'S2', name: 'B', cycleTime: s2Cycle, inputBufferId: 'BUF1', outputBufferId: null },
    ],
    buffers: [ { id: 'BUF0', capacity: 4 }, { id: 'BUF1', capacity: 4 } ],
  };
}

function runTicks(engine, n) { for (let i = 0; i < n; i++) engine._tick(); }

test('regression: default line still produces parts at the Sink', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG
  runTicks(engine, 400);
  assert.ok(engine.sink.partsReceived > 0, 'default line completed no parts');
});

test('domino prevention: a freshly emitted part cannot reach the Sink in one tick', () => {
  const engine = new SimulationEngine(twoStationConfig(1, 1));
  // Both machines cycleTime 1; with end→start processing a part still needs
  // multiple ticks to traverse two stations.
  engine._tick();
  assert.equal(engine.sink.partsReceived, 0);
});

test('getState machines expose stationId + buffer wiring', () => {
  const engine = new SimulationEngine(twoStationConfig());
  const a = engine.getState().machines.find(m => m.id === 'A');
  assert.equal(a.stationId, 'S1');
  assert.equal(a.inputBufferId, 'BUF0');
  assert.equal(a.outputBufferId, 'BUF1');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `getState` machines lack `stationId`/`inputBufferId`/`outputBufferId` (the wiring assertions fail; regression/domino may pass or error).

- [ ] **Step 3: Add buffer index + station-order helpers to `_reset`**

In `src/simulation/engine.js`, replace the body of `_reset()` (currently lines 178-192) with:

```js
  _reset() {
    this.tick = 0;
    this._history = [];

    const cfg = this._config;

    this.source    = new Source(cfg.source);
    this.buffers   = cfg.buffers.map(b => new Buffer(b));
    this.machines  = cfg.machines.map(m => new Machine(m));
    this.sink      = new Sink();
    this.scrapSink = new ScrapSink();

    this._reindex();

    // Store initial config values so reset always goes back to defaults
    this._initialConfig = JSON.parse(JSON.stringify(cfg));
  }

  // Rebuild the buffer lookup and station ordering. Call whenever the set of
  // machines or buffers changes (reset, spawn, remove).
  _reindex() {
    this._bufferById = new Map(this.buffers.map(b => [b.id, b]));
    this._assignStationOrder();
  }

  // Walk the buffer graph from the source-fed buffer (the one no machine
  // produces) and assign each station an increasing `order`. Machines sharing a
  // stationId share an order. Used to process downstream→upstream each tick.
  _assignStationOrder() {
    const produced = new Set(
      this.machines.map(m => m.outputBufferId).filter(id => id != null)
    );
    let curId = this.buffers.find(b => !produced.has(b.id))?.id
              ?? this.buffers[0]?.id;

    const stationOrder = new Map();   // stationId -> order
    let order = 0;
    const seen = new Set();
    while (curId != null && !seen.has(curId)) {
      seen.add(curId);
      const here = this.machines.filter(m => m.inputBufferId === curId);
      if (here.length === 0) break;
      const stationId = here[0].stationId;
      if (!stationOrder.has(stationId)) stationOrder.set(stationId, order++);
      curId = here[0].outputBufferId;   // parallel machines share output
    }
    for (const m of this.machines) {
      m._order = stationOrder.get(m.stationId) ?? 0;
    }
    // Machines processed end→start: highest order first.
    this._processOrder = [...this.machines].sort((a, b) => b._order - a._order);
  }
```

- [ ] **Step 4: Rewrite `_tick` STEP 1 + STEP 3 to use the process order and id lookups**

In `_tick()`, replace STEP 1 (currently lines 213-223) with:

```js
    // ── STEP 1: Advance machines (count down processing timers) ─────────────
    // Process downstream→upstream (highest station order first) to prevent a
    // part cascading through multiple machines in one tick.
    for (const machine of this._processOrder) {
      this._advanceMachine(machine);
    }
```

Replace STEP 3 (currently lines 228-256) with:

```js
    // ── STEP 3: Pull parts from each machine's input buffer ──────────────────
    for (const machine of this._processOrder) {
      if (machine.state === MachineState.IDLE || machine.state === MachineState.STARVED) {
        const upstreamBuffer = this._bufferById.get(machine.inputBufferId);
        if (upstreamBuffer && upstreamBuffer.parts.length > 0) {
          const part = upstreamBuffer.parts.shift();
          upstreamBuffer.totalPartsOut++;

          const waitTicks = this.tick - part._bufferEnterTick;
          upstreamBuffer.totalWaitTicks += (waitTicks > 0 ? waitTicks : 0);

          part.enteredMachineAt = this.tick;
          machine.currentPart   = part;
          machine.ticksLeft     = machine.cycleTime;
          machine.state         = MachineState.PROCESSING;
        } else {
          machine.state = MachineState.STARVED;
        }
      }
    }
```

- [ ] **Step 5: Rewrite `_advanceMachine` + `_tryPushDownstream` to use ids**

Replace `_advanceMachine(machine, index)` (currently lines 323-360) with a version that takes only `machine`:

```js
  _advanceMachine(machine) {
    if (machine.state === MachineState.BLOCKED) {
      this._tryPushDownstream(machine);
      return;
    }

    if (machine.state !== MachineState.PROCESSING) return;

    machine.ticksLeft--;
    if (machine.ticksLeft > 0) return; // still working

    machine.partsProcessed++;

    // Quality gate: randomly reject parts based on rejectRate
    if (machine.rejectRate > 0 && Math.random() < machine.rejectRate) {
      this.scrapSink.partsReceived++;
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    this._tryPushDownstream(machine);
  }
```

Replace `_tryPushDownstream(machine, index)` (currently lines 362-392) with:

```js
  _tryPushDownstream(machine) {
    const part = machine.currentPart;

    if (machine.outputBufferId == null) {
      // Pushes to the Sink
      part.completedAt = this.tick;
      this.sink.partsReceived++;
      this.sink.completedParts.push(part);
      if (this.sink.completedParts.length > 200) this.sink.completedParts.shift();
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    const downstreamBuffer = this._bufferById.get(machine.outputBufferId);
    if (downstreamBuffer && downstreamBuffer.parts.length < downstreamBuffer.capacity) {
      part._bufferEnterTick = this.tick;
      downstreamBuffer.parts.push(part);
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
    } else {
      // Buffer full → BLOCKED (back-pressure propagates upstream)
      machine.state = MachineState.BLOCKED;
    }
  }
```

- [ ] **Step 6: Extend `getState` machine entries**

In `getState()`, the machines map (currently lines 141-154), add three fields inside the per-machine object (after `id:` / `name:`):

```js
      machines: this.machines.map(m => ({
        id:              m.id,
        stationId:       m.stationId,
        inputBufferId:   m.inputBufferId,
        outputBufferId:  m.outputBufferId,
        name:            m.name,
        cycleTime:       m.cycleTime,
        rejectRate:      m.rejectRate,
        state:           m.state,
        ticksLeft:       m.ticksLeft,
        ticksProcessing: m.ticksProcessing,
        ticksBlocked:    m.ticksBlocked,
        ticksStarved:    m.ticksStarved,
        ticksIdle:       m.ticksIdle,
        partsProcessed:  m.partsProcessed,
        currentPartId:   m.currentPart?.id ?? null,
      })),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS (all three).

- [ ] **Step 8: Run the full suite (no regressions in earlier tasks)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/simulation/engine.js test/engine.test.js
git commit -m "refactor: engine uses id-based wiring + station-order processing"
```

---

## Task 4: Engine — `spawnMachine`

**Files:**
- Modify: `src/simulation/engine.js` (add method + cap constant)
- Modify: `test/engine.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/engine.test.js`:

```js
test('spawnMachine adds a parallel machine sharing the station wiring', () => {
  const engine = new SimulationEngine(twoStationConfig());
  const res = engine.spawnMachine({ stationId: 'S2' });
  assert.equal(res.ok, true);
  const station = engine.machines.filter(m => m.stationId === 'S2');
  assert.equal(station.length, 2);
  const spawned = station.find(m => m.id !== 'B');
  assert.equal(spawned.id, 'Bb');
  assert.equal(spawned.inputBufferId, 'BUF1');
  assert.equal(spawned.outputBufferId, null);
  assert.equal(spawned.cycleTime, station[0].cycleTime);
});

test('spawnMachine respects the 4-machine-per-station cap', () => {
  const engine = new SimulationEngine(twoStationConfig());
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bb
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bc
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bd
  const capped = engine.spawnMachine({ stationId: 'S2' });          // 5th
  assert.equal(capped.ok, false);
  assert.equal(engine.machines.filter(m => m.stationId === 'S2').length, 4);
});

test('spawnMachine persists across reset() but not resetToDefaults()', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG, station S3 = M3
  engine.spawnMachine({ stationId: 'S3' });
  engine.reset();
  assert.equal(engine.machines.filter(m => m.stationId === 'S3').length, 2);
  engine.resetToDefaults();
  assert.equal(engine.machines.filter(m => m.stationId === 'S3').length, 1);
});

test('a second machine increases a bottleneck station throughput', () => {
  const base = new SimulationEngine(twoStationConfig(1, 8)); // S2 is the slow station
  runTicks(base, 600);
  const single = base.sink.partsReceived;

  const dbl = new SimulationEngine(twoStationConfig(1, 8));
  dbl.spawnMachine({ stationId: 'S2' });
  runTicks(dbl, 600);
  assert.ok(dbl.sink.partsReceived > single,
    `expected parallel station to finish more parts (${dbl.sink.partsReceived} vs ${single})`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `engine.spawnMachine is not a function`.

- [ ] **Step 3: Add the cap constant + `spawnMachine` method**

Near the top of `src/simulation/engine.js`, after the imports (after line 22), add:

```js
// Maximum machines allowed per station (original + 3 parallel).
const MAX_MACHINES_PER_STATION = 4;
const SPAWN_SUFFIXES = ['b', 'c', 'd'];   // M3 → M3b → M3c → M3d
```

Add this method to the `SimulationEngine` class (place it in the Public API section, e.g. after `updateConfig`, before `getHistory`):

```js
  // Add a parallel machine to a station. The new machine shares the station's
  // input/output buffers and copies its cycleTime / rejectRate. Returns
  // { ok, id?, reason? }. New machines are appended to _config so reset() keeps
  // them; resetToDefaults() drops them.
  spawnMachine({ stationId } = {}) {
    const stationMachines = this.machines.filter(m => m.stationId === stationId);
    if (stationMachines.length === 0) return { ok: false, reason: 'unknown-station' };
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) {
      return { ok: false, reason: 'cap-reached' };
    }

    const template = stationMachines[0];
    const usedSuffixes = new Set(
      stationMachines
        .map(m => m.id.slice(template.id.length))
        .filter(Boolean)
    );
    const suffix = SPAWN_SUFFIXES.find(s => !usedSuffixes.has(s));
    if (!suffix) return { ok: false, reason: 'cap-reached' };
    const newId = template.id + suffix;

    const cfgEntry = {
      id: newId,
      stationId,
      name: template.name,
      cycleTime: template.cycleTime,
      rejectRate: template.rejectRate,
      inputBufferId: template.inputBufferId,
      outputBufferId: template.outputBufferId,
    };

    this._config.machines.push(cfgEntry);
    this.machines.push(new Machine(cfgEntry));
    this._reindex();

    return { ok: true, id: newId };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS (all spawn tests).

- [ ] **Step 5: Commit**

```bash
git add src/simulation/engine.js test/engine.test.js
git commit -m "feat: engine spawnMachine adds parallel machines (capped, persistent)"
```

---

## Task 5: Engine — `removeMachine`

**Files:**
- Modify: `src/simulation/engine.js` (add method)
- Modify: `test/engine.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/engine.test.js`:

```js
import { MachineState } from '../src/simulation/entities.js';

test('removeMachine deletes a spawned machine', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb
  const res = engine.removeMachine({ machineId: 'Bb' });
  assert.equal(res.ok, true);
  assert.equal(engine.machines.filter(m => m.stationId === 'S2').length, 1);
  assert.ok(!engine._config.machines.some(m => m.id === 'Bb'));
});

test('removeMachine refuses to remove the original station machine', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb exists, B is original
  const res = engine.removeMachine({ machineId: 'B' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'original-machine');
});

test('removeMachine returns a held part to its input buffer', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb
  const bb = engine.machines.find(m => m.id === 'Bb');
  const buf1 = engine._bufferById.get('BUF1');
  // Give Bb a part to hold and empty the buffer.
  bb.currentPart = { id: 999, _bufferEnterTick: 0 };
  bb.state = MachineState.PROCESSING;
  buf1.parts = [];
  engine.removeMachine({ machineId: 'Bb' });
  assert.equal(buf1.parts.length, 1);
  assert.equal(buf1.parts[0].id, 999);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `engine.removeMachine is not a function`.

- [ ] **Step 3: Add the `removeMachine` method**

Add to `SimulationEngine`, right after `spawnMachine`:

```js
  // Remove a spawned parallel machine. The station's original machine (first in
  // config order) cannot be removed. If the machine holds a part, the part is
  // returned to the head of its input buffer; if that buffer is full the part is
  // dropped. Returns { ok, reason? }.
  removeMachine({ machineId } = {}) {
    const machine = this.machines.find(m => m.id === machineId);
    if (!machine) return { ok: false, reason: 'unknown-machine' };

    const stationMachines = this.machines.filter(m => m.stationId === machine.stationId);
    if (stationMachines[0].id === machineId) {
      return { ok: false, reason: 'original-machine' };
    }

    if (machine.currentPart) {
      const buf = this._bufferById.get(machine.inputBufferId);
      if (buf && buf.parts.length < buf.capacity) {
        machine.currentPart._bufferEnterTick = this.tick;
        buf.parts.unshift(machine.currentPart);
      }
      machine.currentPart = null;
    }

    this.machines = this.machines.filter(m => m.id !== machineId);
    this._config.machines = this._config.machines.filter(m => m.id !== machineId);
    this._reindex();

    return { ok: true };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/simulation/engine.js test/engine.test.js
git commit -m "feat: engine removeMachine (refuses original, returns held part)"
```

---

## Task 6: Collector — input-buffer queue wait, utilization bottleneck, suggestion

**Files:**
- Modify: `src/metrics/collector.js`
- Create: `test/collector.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/collector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../src/metrics/collector.js';

// Build a minimal state snapshot. `procByStation` maps stationId → ticksProcessing
// applied to every machine in that station; total ticks is fixed at 100.
function makeState(machineSpecs) {
  return {
    tick: 100,
    machines: machineSpecs.map(s => ({
      id: s.id, stationId: s.stationId, name: s.name ?? s.id,
      inputBufferId: s.inputBufferId, outputBufferId: s.outputBufferId ?? null,
      state: 'PROCESSING', currentPartId: 1, cycleTime: 5, rejectRate: 0,
      ticksProcessing: s.proc, ticksBlocked: s.blocked ?? 0,
      ticksStarved: s.starved ?? (100 - s.proc - (s.blocked ?? 0)), ticksIdle: 0,
      partsProcessed: s.proc,
    })),
    buffers: [
      { id: 'BUF0', capacity: 4, load: 0, totalWaitTicks: 50, totalPartsOut: 10 },
      { id: 'BUF1', capacity: 4, load: 0, totalWaitTicks: 200, totalPartsOut: 10 },
    ],
    sink: { partsReceived: 10, recentParts: [] },
    scrap: { partsReceived: 0 },
  };
}

test('bottleneck is the busiest station (highest utilization)', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  const b = m.machines.find(x => x.id === 'B');
  const a = m.machines.find(x => x.id === 'A');
  assert.equal(b.bottleneck, true);
  assert.equal(a.bottleneck, false);
});

test('suggestion targets the bottleneck station below the cap', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.suggestion);
  assert.equal(m.suggestion.type, 'add-parallel-machine');
  assert.equal(m.suggestion.stationId, 'S2');
  assert.equal(m.suggestion.machineId, 'B');
  assert.match(m.suggestion.label, /B/);
});

test('no suggestion when no station exceeds the utilization threshold', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 20 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 25 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.suggestion, null);
  assert.ok(m.machines.every(x => x.bottleneck === false));
});

test('no suggestion when the bottleneck station is already at the cap', () => {
  const state = makeState([
    { id: 'A',  stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B',  stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bb', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bc', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
    { id: 'Bd', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  // Station S2 is still flagged as the bottleneck, but it is full → no suggestion.
  assert.ok(m.machines.find(x => x.id === 'B').bottleneck);
  assert.equal(m.suggestion, null);
});

test('avgQueueWait uses the machine input buffer', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  // BUF1: 200 waitTicks / 10 out = 20; BUF0: 50/10 = 5.
  assert.equal(m.machines.find(x => x.id === 'B').avgQueueWait, 20);
  assert.equal(m.machines.find(x => x.id === 'A').avgQueueWait, 5);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/collector.test.js`
Expected: FAIL — `m.suggestion` is `undefined`; bottleneck/avgQueueWait assertions fail.

- [ ] **Step 3: Replace the per-machine, bottleneck, and return sections of `collector.js`**

In `src/metrics/collector.js`, add the threshold and cap constants near the top of the file (after the closing `*/` of the header doc, before the `export function`):

```js
// A station whose average machine utilization exceeds this is treated as the
// line's constraint (bottleneck). Tunable.
const BOTTLENECK_UTIL_THRESHOLD = 0.6;
// Keep in sync with engine MAX_MACHINES_PER_STATION — no point suggesting a
// spawn for a station that is already full.
const MAX_MACHINES_PER_STATION = 4;
```

Replace the per-machine metrics block (currently lines 53-78) with:

```js
  // ── Per-machine metrics ────────────────────────────────────────────────────
  const bufferById = {};
  for (const b of buffers) bufferById[b.id] = b;

  const machineMetrics = machines.map(m => {
    const totalTicks = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
    const utilization = totalTicks > 0 ? m.ticksProcessing / totalTicks : 0;

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
      currentState: m.state,
      bottleneck:   false, // filled in below
    };
  });
```

Replace the bottleneck detection block (currently lines 80-104) with:

```js
  // ── Bottleneck detection (station-level, utilization-based) ─────────────────
  // The constraint is the busiest STATION: the one whose machines spend the
  // largest share of time PROCESSING. (The previous blocked-ratio heuristic
  // flagged the machine *upstream* of the constraint — the wrong place to add
  // capacity.) Adding a parallel machine lowers per-machine utilization, so the
  // flagged bottleneck moves — the intended teaching feedback.
  const stationStats = new Map();   // stationId -> { utilSum, count }
  machineMetrics.forEach(mm => {
    const s = stationStats.get(mm.stationId) ?? { utilSum: 0, count: 0 };
    s.utilSum += mm.utilization;
    s.count   += 1;
    stationStats.set(mm.stationId, s);
  });

  let bottleneckStationId = null;
  let maxStationUtil      = -1;
  for (const [stationId, s] of stationStats) {
    const avgUtil = s.count > 0 ? s.utilSum / s.count : 0;
    if (avgUtil > maxStationUtil) {
      maxStationUtil      = avgUtil;
      bottleneckStationId = stationId;
    }
  }

  let suggestion = null;
  if (bottleneckStationId != null && maxStationUtil > BOTTLENECK_UTIL_THRESHOLD) {
    machineMetrics.forEach(mm => {
      if (mm.stationId === bottleneckStationId) mm.bottleneck = true;
    });

    const stationMachines = machineMetrics.filter(mm => mm.stationId === bottleneckStationId);
    if (stationMachines.length < MAX_MACHINES_PER_STATION) {
      const rep = stationMachines[0];
      suggestion = {
        type: 'add-parallel-machine',
        stationId: bottleneckStationId,
        machineId: rep.id,
        label: `${rep.id} (${rep.name}) ist der Engpass — füge 1 parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
      };
    }
  }
```

Replace the final `return { ... }` block (currently lines 114-122) with the same object plus `suggestion`:

```js
  return {
    throughput:    Math.round(throughput * 100) / 100,
    avgLeadTime:   Math.round(avgLeadTime * 10) / 10,
    scrappedParts: scrap.partsReceived,
    machines:      machineMetrics,
    buffers:       bufferMetrics,
    simTime:       tick,
    partsInSystem,
    suggestion,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/collector.test.js`
Expected: PASS (all six).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/metrics/collector.js test/collector.test.js
git commit -m "feat: station-level utilization bottleneck + spawn suggestion in collector"
```

---

## Task 7: Server — spawn/remove control actions

**Files:**
- Modify: `src/server.js:151-158`

- [ ] **Step 1: Add the two control actions**

In `src/server.js`, in the `/api/control` handler's `switch (action)` (currently lines 151-158), add two cases before `default`:

```js
    case 'play':            engine.play();            break;
    case 'pause':           engine.pause();           break;
    case 'reset':           engine.reset();           break;
    case 'resetToDefaults': engine.resetToDefaults(); break;
    case 'spawnMachine':    engine.spawnMachine(params);  break;
    case 'removeMachine':   engine.removeMachine(params); break;
    default:
      // No recognised action — may still have params to update
```

- [ ] **Step 2: Manual verification (server has no test harness)**

Run: `node src/server.js` (in a second terminal)
Then:

```bash
SID=$(curl -s -i http://localhost:3000/api/state | grep -i '^set-cookie' | sed -E 's/.*sid=([^;]+).*/\1/')
# Spawn a parallel machine at station S3 (Montage):
curl -s -X POST http://localhost:3000/api/control \
  -H 'Content-Type: application/json' -b "sid=$SID" \
  -d '{"action":"spawnMachine","params":{"stationId":"S3"}}'
# Confirm a second S3 machine (id M3b) now exists:
curl -s -b "sid=$SID" http://localhost:3000/api/state | grep -o '"id":"M3b"'
```

Expected: the control call returns `{"ok":true,...}` and the grep prints `"id":"M3b"`. Stop the server (Ctrl-C) when done.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: spawnMachine/removeMachine control actions"
```

---

## Task 8: Frontend HTML + CSS — suggestion banner & station controls

**Files:**
- Modify: `src/public/index.html` (banner element + machine-detail controls)
- Modify: `src/public/style.css` (append styles)

- [ ] **Step 1: Add the suggestion banner element**

In `src/public/index.html`, inside `#pipeline-container`, immediately after the opening `<div id="pipeline-container">` line (line 23) and before the `<svg ...>` line, insert:

```html
    <div id="suggestion-banner" hidden></div>
```

- [ ] **Step 2: Add station controls to the machine-detail panel**

In `src/public/index.html`, inside `<aside id="machine-detail">`, immediately after the `</header>` of the panel (after line 35) insert:

```html
      <div class="md-station-controls">
        <button id="md-spawn" type="button">+ Parallele Maschine</button>
        <button id="md-remove" type="button">– Maschine entfernen</button>
      </div>
```

- [ ] **Step 3: Append styles**

Append to `src/public/style.css`:

```css
/* ── Spawn suggestion banner ─────────────────────────────────────────────── */
#suggestion-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: #7c2d12;
  border-bottom: 1px solid #f97316;
  color: #fdba74;
  font-size: 0.85rem;
  font-weight: 600;
}
#suggestion-banner[hidden] { display: none; }
#suggestion-banner .sg-btn {
  background: #f97316;
  color: #1a1d27;
  font-weight: 700;
  white-space: nowrap;
}

/* ── Machine-detail station controls ─────────────────────────────────────── */
.md-station-controls {
  display: flex;
  gap: 8px;
  margin: 4px 0 10px;
}
.md-station-controls #md-spawn  { background: var(--processing); color: #fff; }
.md-station-controls #md-remove { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.md-station-controls button:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html src/public/style.css
git commit -m "feat: suggestion banner + station control markup/styles"
```

---

## Task 9: Frontend app.js — data-driven layout

Replace the hardcoded `LAYOUT`/`CONNECTORS` and the draw/cache logic with a layout computed from state. This task leaves the visualization working for the default line; later tasks add transfers, banner, and controls.

**Files:**
- Modify: `src/public/app.js`

- [ ] **Step 1: Replace the layout constants block**

In `src/public/app.js`, replace the `LAYOUT` constant and the `CONNECTORS` array (currently lines 26-56) with:

```js
// Column spacing for the computed layout.
const COL_GAP = 34;   // horizontal gap between columns
const VGAP    = 16;   // vertical gap between stacked parallel machines
const X0      = 20;   // left margin

// Populated by computeLayout()/buildPipeline(): the active layout for this frame.
// { columns, pos:{ source, sink, scrap, buffers:{id->{x,y}}, machines:{id->{x,y,cx,cy}} },
//   connectors:[{ id, destBufferId, line|path geometry }], srcBufId, viewBox }
let layout = null;
```

- [ ] **Step 2: Add `computeLayout`**

In `src/public/app.js`, immediately after the block added in Step 1, add:

```js
// Build a left→right column layout from the simulation state. Parallel machines
// in a station stack vertically, centered on the main line.
function computeLayout(state) {
  const bufById = {};
  for (const b of state.buffers) bufById[b.id] = b;

  // The source-fed buffer is the one no machine produces.
  const produced = new Set(state.machines.map(m => m.outputBufferId).filter(id => id != null));
  const srcBuf = state.buffers.find(b => !produced.has(b.id)) ?? state.buffers[0];

  // Group machines into stations by input buffer.
  const stationByInput = {};
  for (const m of state.machines) (stationByInput[m.inputBufferId] ??= []).push(m);

  // Walk the chain: SOURCE, then [buffer, station]..., then SINK.
  const columns = [{ kind: 'source' }];
  let curId = srcBuf?.id;
  const seen = new Set();
  while (curId != null && !seen.has(curId)) {
    seen.add(curId);
    columns.push({ kind: 'buffer', buffer: bufById[curId] });
    const machines = stationByInput[curId] ?? [];
    if (machines.length === 0) break;
    columns.push({ kind: 'station', machines, stationId: machines[0].stationId });
    curId = machines[0].outputBufferId;
  }
  columns.push({ kind: 'sink' });

  const widthOf = (c) =>
    c.kind === 'source' ? SRC_W :
    c.kind === 'buffer' ? BUF_W :
    c.kind === 'station' ? MACH_W : SINK_W;

  let x = X0;
  for (const c of columns) { c.x = x; x += widthOf(c) + COL_GAP; }
  const totalW = x - COL_GAP + X0;

  const pos = { machines: {}, buffers: {}, source: null, sink: null, scrap: null };
  let minY = MAIN_Y - SRC_H / 2;
  let maxY = MAIN_Y + SRC_H / 2;

  for (const c of columns) {
    if (c.kind === 'source')  pos.source = { x: c.x };
    else if (c.kind === 'sink') pos.sink = { x: c.x };
    else if (c.kind === 'buffer') pos.buffers[c.buffer.id] = { x: c.x, y: MAIN_Y - BUF_H / 2 };
    else if (c.kind === 'station') {
      const k = c.machines.length;
      c.machines.forEach((m, j) => {
        const cy = MAIN_Y + (j - (k - 1) / 2) * (MACH_H + VGAP);
        const y  = cy - MACH_H / 2;
        pos.machines[m.id] = { x: c.x, y, cx: c.x + MACH_W / 2, cy };
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + MACH_H);
      });
    }
  }

  // Scrap sink sits below the lowest element, under the rejecting station.
  const rejectCol = columns.find(c => c.kind === 'station' && c.machines.some(m => m.rejectRate > 0));
  const scrapY = maxY + 40;
  const scrapX = rejectCol ? rejectCol.x : totalW / 2;
  pos.scrap = { x: scrapX, y: scrapY };
  maxY = scrapY + SINK_H;

  // Connectors.
  const connectors = [];
  if (pos.source && pos.buffers[srcBuf.id]) {
    connectors.push({
      id: 'conn-src-b0', destBufferId: srcBuf.id,
      x1: pos.source.x + SRC_W, y1: MAIN_Y, x2: pos.buffers[srcBuf.id].x, y2: MAIN_Y,
    });
  }
  for (const m of state.machines) {
    const mp = pos.machines[m.id];
    const inBuf = pos.buffers[m.inputBufferId];
    if (inBuf) connectors.push({
      id: `conn-in-${m.id}`, destBufferId: null,
      x1: inBuf.x + BUF_W, y1: MAIN_Y, x2: mp.x, y2: mp.cy,
    });
    if (m.outputBufferId == null) {
      connectors.push({
        id: `conn-out-${m.id}`, destBufferId: null,
        x1: mp.x + MACH_W, y1: mp.cy, x2: pos.sink.x, y2: MAIN_Y,
      });
    } else {
      const outBuf = pos.buffers[m.outputBufferId];
      if (outBuf) connectors.push({
        id: `conn-out-${m.id}`, destBufferId: m.outputBufferId,
        x1: mp.x + MACH_W, y1: mp.cy, x2: outBuf.x, y2: MAIN_Y,
      });
    }
    if (m.rejectRate > 0) {
      const sy = pos.scrap.y + SINK_H / 2;
      connectors.push({
        id: `conn-scrap-${m.id}`, destBufferId: null, isPath: true,
        d: `M ${mp.cx} ${mp.y + MACH_H} L ${mp.cx} ${sy} L ${pos.scrap.x} ${sy}`,
      });
    }
  }

  const vbY = minY - 20;
  return {
    columns, pos, connectors, srcBufId: srcBuf.id,
    viewBox: { x: 0, y: vbY, w: totalW, h: (maxY - vbY) + 20 },
  };
}
```

- [ ] **Step 3: Rewrite `cacheConnectorGeometry` to iterate the layout**

Replace `cacheConnectorGeometry()` (currently lines 63-89) with:

```js
function cacheConnectorGeometry() {
  for (const { id } of layout.connectors) {
    const node = document.getElementById(id);
    if (!node) continue;

    if (node.tagName === 'line') {
      const x1 = parseFloat(node.getAttribute('x1'));
      const y1 = parseFloat(node.getAttribute('y1'));
      const x2 = parseFloat(node.getAttribute('x2'));
      const y2 = parseFloat(node.getAttribute('y2'));
      connectorLength[id]  = Math.hypot(x2 - x1, y2 - y1);
      connectorPointAt[id] = (t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
    } else {
      const len = node.getTotalLength();
      connectorLength[id]  = len;
      connectorPointAt[id] = (t) => {
        const p = node.getPointAtLength(len * t);
        return { x: p.x, y: p.y };
      };
    }
  }
}
```

- [ ] **Step 4: Rewrite `buildPipeline` to take state and draw from the layout**

Replace `buildPipeline()` (currently lines 177-260) with:

```js
function buildPipeline(state) {
  svg.innerHTML = '';   // clear on reset / structure change

  layout = computeLayout(state);
  const vb = layout.viewBox;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

  // ── Connectors ─────────────────────────────────────────────────────────────
  for (const c of layout.connectors) {
    const node = c.isPath
      ? el('path', { id: c.id, d: c.d, class: 'pipe-connector' })
      : el('line', { id: c.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, class: 'pipe-connector' });
    svg.appendChild(node);
  }

  // ── Particle overlay (above connectors, below stations) ─────────────────────
  const defs = el('defs');
  const glow = el('filter', { id: 'part-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: '2.2' }));
  defs.appendChild(glow);
  svg.appendChild(defs);

  const particleLayer = el('g', { id: 'particle-layer', filter: 'url(#part-glow)' });
  svg.appendChild(particleLayer);

  cacheConnectorGeometry();

  particlePool = [];
  particles    = [];
  ensureParticleNodes(32);
  startParticleLoop();

  // ── Stations / buffers / endpoints ──────────────────────────────────────────
  drawSource(layout.pos.source);
  for (const b of state.buffers) drawBuffer(b, layout.pos.buffers[b.id]);
  for (const m of state.machines) drawMachine(m, layout.pos.machines[m.id]);
  drawSink(layout.pos.sink);
  drawScrapSink(layout.pos.scrap);
}
```

- [ ] **Step 5: Update the draw helpers to use computed positions**

Replace `drawSource()` (currently lines 264-283) with:

```js
function drawSource(p) {
  const x = p.x;
  const y = MAIN_Y - SRC_H / 2;
  const g = el('g', { id: 'elem-SOURCE' });

  g.appendChild(el('rect', { x, y, width: SRC_W, height: SRC_H, rx: 6,
    fill: '#1a1d27', stroke: '#4f46e5', 'stroke-width': 1.5 }));
  g.appendChild(el('rect', { id: 'src-stock-bg', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#252836' }));
  g.appendChild(el('rect', { id: 'src-stock-fill', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#6366f1' }));
  g.appendChild(txt('SOURCE', { x: x + SRC_W / 2, y: y + 18, 'text-anchor': 'middle', 'font-size': '10', fill: '#818cf8' }));
  g.appendChild(txt('', { id: 'src-stock-text', x: x + SRC_W / 2, y: y + 38, 'text-anchor': 'middle', 'font-size': '11' }));

  svg.appendChild(g);
}
```

Replace `drawBuffer(id, x, y, defaultCap)` (currently lines 285-301) with a version taking the buffer object + position:

```js
function drawBuffer(buf, p) {
  const id = buf.id, x = p.x, y = p.y;
  const g = el('g', { id: `elem-${id}` });

  g.appendChild(el('rect', { x, y, width: BUF_W, height: BUF_H, rx: 5,
    fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.2 }));
  g.appendChild(txt(id, { x: x + BUF_W / 2, y: y + 13, 'text-anchor': 'middle', 'font-size': '9', fill: '#64748b' }));
  g.appendChild(txt('0/0', { id: `buf-load-${id}`, x: x + BUF_W / 2, y: y + BUF_H - 5, 'text-anchor': 'middle', 'font-size': '10' }));
  g.appendChild(el('g', { id: `buf-slots-${id}` }));

  svg.appendChild(g);
}
```

Replace the `drawMachine(id, x, y, name, cycleTime)` signature and body (currently lines 303-374). Change the signature line and the first geometry lines so positions come from `p`; the rest of the body is unchanged except `x`/`y` now come from `p`:

```js
function drawMachine(m, p) {
  const id = m.id, name = m.name;
  const x = p.x, y = p.y;
  const g = el('g', { id: `elem-${id}` });
  g.addEventListener('click', () => openMachineDetail(id));

  g.appendChild(el('rect', { id: `mach-rect-${id}`, x, y, width: MACH_W, height: MACH_H,
    rx: 8, class: 'machine-rect IDLE', fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.5 }));

  const shortName = name.length > 17 ? name.slice(0, 16) + '…' : name;
  g.appendChild(txt(shortName, { x: x + MACH_W / 2, y: y + 11, 'text-anchor': 'middle',
    'font-size': '9.5', fill: '#94a3b8' }));
  g.appendChild(txt(id, { x: x + MACH_W / 2, y: y + 22, 'text-anchor': 'middle',
    'font-size': '9', fill: '#64748b' }));

  const cx = x + MACH_W / 2;
  const cy = y + MACH_H / 2 + 6;
  const r  = 20;
  const circ = 2 * Math.PI * r;

  g.appendChild(el('circle', { cx, cy, r, fill: 'none', stroke: '#252836', 'stroke-width': 4 }));
  const arc = el('circle', {
    id: `mach-arc-${id}`, cx, cy, r, fill: 'none',
    stroke: '#22c55e', 'stroke-width': 4,
    'stroke-dasharray': circ.toFixed(2),
    'stroke-dashoffset': circ.toFixed(2),
    transform: `rotate(-90 ${cx} ${cy})`,
  });
  g.appendChild(arc);

  g.appendChild(txt('0%', { id: `mach-util-${id}`, cx, cy,
    x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': '9', fill: '#94a3b8' }));

  g.appendChild(el('rect', { id: `mach-badge-bg-${id}`, x: x + 4, y: y + MACH_H - 18, width: 50, height: 14,
    rx: 7, fill: '#1e293b' }));
  g.appendChild(txt('IDLE', { id: `mach-badge-${id}`, x: x + 29, y: y + MACH_H - 7,
    'text-anchor': 'middle', 'font-size': '8', fill: '#94a3b8' }));

  const bnG = el('g', { id: `mach-bn-${id}`, class: 'mach-bn-marker', visibility: 'hidden' });
  const badgeW = 78, badgeH = 18;
  const badgeX = x + MACH_W / 2 - badgeW / 2;
  const badgeY = y - badgeH - 10;
  bnG.appendChild(el('rect', { x: badgeX, y: badgeY, width: badgeW, height: badgeH, rx: 9,
    fill: '#7c2d12', stroke: '#f97316', 'stroke-width': 1.2 }));
  bnG.appendChild(txt('⚠ ENGPASS', { x: x + MACH_W / 2, y: badgeY + badgeH - 5,
    'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
    fill: '#fdba74', 'font-family': 'Inter, system-ui, sans-serif' }));
  const arrowTopY = badgeY + badgeH, arrowTipY = y - 1, arrowCx = x + MACH_W / 2;
  bnG.appendChild(el('polygon', {
    points: `${arrowCx - 5},${arrowTopY} ${arrowCx + 5},${arrowTopY} ${arrowCx},${arrowTipY}`,
    fill: '#f97316',
  }));
  g.appendChild(bnG);

  svg.appendChild(g);
}
```

Replace `drawSink(x, y)` (currently lines 376-385) with:

```js
function drawSink(p) {
  const x = p.x, y = MAIN_Y - SINK_H / 2;
  const g = el('g', { id: 'elem-SINK' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#22c55e', 'stroke-width': 1.5 }));
  g.appendChild(txt('SINK', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#86efac' }));
  g.appendChild(txt('0', { id: 'sink-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#22c55e', 'font-weight': 'bold' }));
  g.appendChild(txt('parts', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#4ade80' }));
  svg.appendChild(g);
}
```

Replace `drawScrapSink(x, y)` (currently lines 387-396) with:

```js
function drawScrapSink(p) {
  const x = p.x, y = p.y;
  const g = el('g', { id: 'elem-SCRAP' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#ef4444', 'stroke-width': 1.5 }));
  g.appendChild(txt('SCRAP', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#f87171' }));
  g.appendChild(txt('0', { id: 'scrap-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#ef4444', 'font-weight': 'bold' }));
  g.appendChild(txt('scrapped', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#fca5a5' }));
  g.appendChild(txt('', { id: 'scrap-rate-label', x: x + SINK_W / 2, y: y - 6, 'text-anchor': 'middle', 'font-size': '10', fill: '#f87171' }));
  svg.appendChild(g);
}
```

- [ ] **Step 6: Update `updateBufferSlots` to use the layout position**

Replace the position lines inside `updateBufferSlots(buf)` (currently lines 486-487):

```js
  const elemX = LAYOUT[buf.id];
  const elemY = MAIN_Y - BUF_H / 2;
```

with:

```js
  const bp    = layout?.pos.buffers[buf.id];
  if (!bp) return;
  const elemX = bp.x;
  const elemY = bp.y;
```

- [ ] **Step 7: Replace the hardcoded connector-blocked section in `updatePipeline`**

Replace the connector-colour block (currently lines 434-446) with a generic loop:

```js
  // ── Connector colours (blocked = destination buffer full) ──────────────────
  const bufMap = {};
  for (const b of state.buffers) bufMap[b.id] = b;
  for (const c of layout.connectors) {
    if (!c.destBufferId) continue;
    const buf = bufMap[c.destBufferId];
    setConnectorBlocked(c.id, !!buf && buf.load >= buf.capacity);
  }
```

- [ ] **Step 8: Update the scrap-rate label lookup in `updatePipeline`**

Replace the M2-specific scrap-rate block (currently lines 452-456) with a generic "first rejecting machine" lookup:

```js
  const rejectMachine = state.machines.find(m => m.rejectRate > 0);
  if (rejectMachine) {
    setTextContent('scrap-rate-label', (rejectMachine.rejectRate * 100).toFixed(0) + '%');
  }
```

- [ ] **Step 9: Update `isDestBufferFull` (particle jam check) to use the layout**

Replace `isDestBufferFull(connectorId)` (currently lines 797-804) with:

```js
function isDestBufferFull(connectorId) {
  if (!particleSimState || !layout) return false;
  const conn = layout.connectors.find(c => c.id === connectorId);
  if (!conn || !conn.destBufferId) return false;
  const buf = particleSimState.buffers.find(b => b.id === conn.destBufferId);
  return buf ? buf.load >= buf.capacity : false;
}
```

- [ ] **Step 10: Rewire boot + SSE to build the layout from state on structure change**

Replace the boot block at the bottom (currently lines 1084-1087):

```js
// ── Boot ──────────────────────────────────────────────────────────────────────

buildPipeline();
connectSSE();
```

with:

```js
// ── Boot ──────────────────────────────────────────────────────────────────────
// The pipeline is built from the first SSE frame (and rebuilt whenever the set
// of machines changes), since the layout is derived from state.

let builtMachineKey = null;   // machine-id signature of the currently-drawn layout

connectSSE();
```

In `connectSSE()`, replace the message handler body (currently lines 1049-1068) with:

```js
  es.addEventListener('message', e => {
    const { state, metrics } = JSON.parse(e.data);
    lastState   = state;
    lastMetrics = metrics;

    // Rebuild the SVG whenever the set of machines changes (spawn/remove/reset).
    const key = state.machines.map(m => m.id).join(',');
    if (key !== builtMachineKey) {
      buildPipeline(state);
      buildControlSliders(state);
      resetParticles();
      prevStateForDiff = state;          // baseline; no spurious deltas this frame
      builtMachineKey  = key;
      // Close the detail panel if its machine no longer exists.
      if (selectedMachineId && !state.machines.some(m => m.id === selectedMachineId)) {
        closeMachineDetail();
      }
    }

    // Particle flow: detect transfers between consecutive snapshots.
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) spawnFromEvents(transfers);
    prevStateForDiff  = state;
    particleSimState  = state;
    particleSimPaused = !state.running;

    updatePipeline(state, metrics);
    updateMetricsDashboard(metrics, state);
    updateSuggestionBanner(metrics);
  });
```

Note: `buildControlSliders` already only checks for the `section-label` child and iterates `state.machines`/`state.buffers`, so it works unchanged for spawned machines. `updateSuggestionBanner` is added in Task 11; until then this line will throw — Task 10 and 11 follow immediately, so do not run the app between Task 9 and 11. (If executing inline, complete Tasks 9–11 before manual verification.)

- [ ] **Step 11: Fix `applyReset` to rebuild from the post-reset state**

Replace the body of `applyReset(action)` (currently lines 978-997) with:

```js
async function applyReset(action) {
  await postControl({}, action);
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
  const m2 = newState.machines.find(m => m.id === 'M2');
  if (m2) {
    const pct = Math.round(m2.rejectRate * 100);
    document.getElementById('reject-rate').value = pct;
    document.getElementById('val-reject-rate').textContent = pct + '%';
  }
}
```

- [ ] **Step 12: Commit (app still references functions added in Tasks 10–11)**

```bash
git add src/public/app.js
git commit -m "feat: data-driven SVG layout (stacks parallel machines)"
```

---

## Task 10: Frontend app.js — generic transfer detection

**Files:**
- Modify: `src/public/app.js` (`detectTransfers`)

- [ ] **Step 1: Replace `detectTransfers` with a generic, per-machine version**

Replace `detectTransfers(prev, next)` (currently lines 94-138) with:

```js
function detectTransfers(prev, next) {
  if (!prev || !next) return [];
  const events = [];

  // Source → source-fed buffer
  const srcDelta = (next.source?.totalGenerated ?? 0) - (prev.source?.totalGenerated ?? 0);
  if (srcDelta > 0) events.push({ connectorId: 'conn-src-b0', kind: 'good', count: srcDelta });

  const prevMach = {};
  for (const m of prev.machines) prevMach[m.id] = m;

  // Scrap is a single global counter; split this frame's scrap across the
  // rejecting machines proportionally to how many parts each processed.
  const scrapDelta = (next.scrap?.partsReceived ?? 0) - (prev.scrap?.partsReceived ?? 0);
  const rejectDeltas = {};
  let sumReject = 0;
  for (const m of next.machines) {
    if (m.rejectRate > 0) {
      const d = Math.max(0, m.partsProcessed - (prevMach[m.id]?.partsProcessed ?? 0));
      rejectDeltas[m.id] = d;
      sumReject += d;
    }
  }

  for (const m of next.machines) {
    const pm = prevMach[m.id];

    // Pull animation: a new part entered this machine (currentPartId changed).
    if (m.currentPartId != null && pm && pm.currentPartId !== m.currentPartId) {
      events.push({ connectorId: `conn-in-${m.id}`, kind: 'good', count: 1 });
    }

    const dProcessed = m.partsProcessed - (pm?.partsProcessed ?? 0);
    if (dProcessed <= 0) continue;

    if (m.rejectRate > 0) {
      const myScrap = sumReject > 0 ? Math.round(scrapDelta * (rejectDeltas[m.id] / sumReject)) : 0;
      const myGood  = Math.max(0, dProcessed - myScrap);
      if (myScrap > 0) events.push({ connectorId: `conn-scrap-${m.id}`, kind: 'scrap', count: myScrap });
      if (myGood  > 0) events.push({ connectorId: `conn-out-${m.id}`,   kind: 'good',  count: myGood });
    } else {
      events.push({ connectorId: `conn-out-${m.id}`, kind: 'good', count: dProcessed });
    }
  }

  return events;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/public/app.js
git commit -m "feat: generic per-machine transfer detection for particles"
```

---

## Task 11: Frontend app.js — suggestion banner + station controls

**Files:**
- Modify: `src/public/app.js` (add banner fn + control handlers)

- [ ] **Step 1: Add `updateSuggestionBanner`**

In `src/public/app.js`, add this function just before the "Control panel" section (before `buildControlSliders`, ~line 912):

```js
// ── Spawn suggestion banner ─────────────────────────────────────────────────

function updateSuggestionBanner(metrics) {
  const banner = document.getElementById('suggestion-banner');
  if (!banner) return;
  const s = metrics?.suggestion;
  if (!s) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML =
    `<span class="sg-text">⚠ ${s.label}</span>` +
    `<button class="sg-btn" id="sg-spawn" type="button">+ Parallele Maschine hinzufügen</button>`;
  document.getElementById('sg-spawn').addEventListener('click', () => {
    postControl({ stationId: s.stationId }, 'spawnMachine');
  });
}
```

- [ ] **Step 2: Wire the machine-detail spawn/remove buttons**

In `src/public/app.js`, in the "Machine detail panel: close handlers" section (after line 1079, `md-close` handler), add:

```js
document.getElementById('md-spawn')?.addEventListener('click', () => {
  const m = lastState?.machines.find(x => x.id === selectedMachineId);
  if (m) postControl({ stationId: m.stationId }, 'spawnMachine');
});
document.getElementById('md-remove')?.addEventListener('click', () => {
  if (selectedMachineId) postControl({ machineId: selectedMachineId }, 'removeMachine');
});
```

- [ ] **Step 3: Disable the remove button for a station's original machine**

In `updateMachineDetail()`, just after the `const m = lastState.machines.find(...)` / `if (!m) return;` lines (currently ~lines 596-597), add:

```js
  const removeBtn = document.getElementById('md-remove');
  if (removeBtn) {
    const stationMachines = lastState.machines.filter(x => x.stationId === m.stationId);
    // The original (first-listed) station machine cannot be removed.
    removeBtn.disabled = stationMachines.length <= 1 || stationMachines[0].id === m.id;
  }
```

- [ ] **Step 4: Manual verification — run the app and exercise the feature**

Run: `node src/server.js`, then open `http://localhost:3000`.

Verify:
- The default 4-machine line renders left→right (Source → BUF0 → M1 → … → M4 → SINK) as before.
- After ~30–60s the **suggestion banner** appears naming the bottleneck (expected: M3 Montage, cycleTime 15). Throughput sparkline is climbing/flat.
- Click **“+ Parallele Maschine hinzufügen”** → a second M3 machine (`M3b`) appears stacked below M3, sharing connectors into BUF2 and out to BUF3; particles flow through both.
- Throughput rises; after the line rebalances, the bottleneck marker/banner moves to a different station (or disappears).
- Click a machine → detail panel shows **“+ Parallele Maschine”** / **“– Maschine entfernen”**; remove is disabled on a station with one machine and enabled on `M3b`. Removing `M3b` returns the line to one M3.
- **Reset** keeps spawned machines; **Reset to Defaults** restores the original 4-machine line.
- Spawn up to the cap (M3, M3b, M3c, M3d) → the banner stops suggesting once the station is full.

If stacked machines overflow the SVG vertically, nudge `VGAP` / `viewBox` padding in `computeLayout` (the `vbY`/`maxY` math) and re-verify.

- [ ] **Step 5: Run the full unit suite once more**

Run: `npm test`
Expected: PASS (all config/entities/engine/collector tests).

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js
git commit -m "feat: spawn suggestion banner + machine-detail station controls"
```

---

## Out of scope (documented in the spec)

- OPC-UA address space is built once at startup from a separate, non-spawning engine instance; spawned machines won't appear in OPC-UA. `_updateNodes` looks up `vars.machines[m.id]` and would need a guard only if that engine ever spawned — it does not.
- Prometheus `/metrics` iterates `metrics.machines` dynamically (labelled by id), so it already handles spawned machines on the first session's engine with no change.
- Inserting new sequential stations (a different feature) is not included.
```
