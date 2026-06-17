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
  assert.ok(m.machines.find(x => x.id === 'B').bottleneck);
  assert.equal(m.suggestion, null);
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
