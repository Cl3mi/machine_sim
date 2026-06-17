import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../src/metrics/collector.js';

// Build a minimal state snapshot. Each machine spec: id, stationId, inputBufferId,
// outputBufferId, proc (ticksProcessing); total ticks fixed at 100.
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
