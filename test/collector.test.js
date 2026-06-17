import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../src/metrics/collector.js';

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

test('multiple un-blocked constraints are suggested highest-confidence first', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.suggestions.length, 2);
  assert.deepEqual(m.suggestions.map(s => s.stationId), ['S2', 'S1']);
  assert.ok(m.suggestions[0].confidence >= m.suggestions[1].confidence);
  assert.equal(m.suggestions[0].flowState, 'CONSTRAINT');
});

test('a source-starved line yields no bottleneck and a diagnostic note', () => {
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
  assert.deepEqual(m.suggestions, []);
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
  assert.match(sug.reason, /95%/);
  assert.match(sug.reason, /blockiert/);
});

test('avgQueueWait uses the machine input buffer', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  // BUF1: 200/10 = 20; BUF0: 50/10 = 5.
  assert.equal(m.machines.find(x => x.id === 'B').avgQueueWait, 20);
  assert.equal(m.machines.find(x => x.id === 'A').avgQueueWait, 5);
});

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
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: 'BUF2', proc: 95, blocked: 0 },
    { id: 'C', stationId: 'S3', inputBufferId: 'BUF2', outputBufferId: null,   proc: 30, blocked: 0, starved: 70 },
  ], { BUF1: { load: 3, capacity: 3 } });
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').isPrimaryConstraint, true);
  assert.equal(m.machines.find(x => x.id === 'A').isPrimaryConstraint, false);
});
