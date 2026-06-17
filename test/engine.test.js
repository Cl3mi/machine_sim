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
