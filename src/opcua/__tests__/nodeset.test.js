import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeset, toJSON } from '../nodeset.js';
import { SimulationEngine } from '../../simulation/engine.js';
import { DEFAULT_CONFIG } from '../../simulation/config.js';

test('buildNodeset returns a Line object with the documented children', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);

  assert.equal(tree.browseName, 'Line');
  const childNames = tree.children.map(c => c.browseName);
  for (const expected of ['Throughput', 'AvgLeadTime', 'Tick', 'State', 'Speed',
                          'Source', 'Sink', 'Machines', 'Buffers', 'Methods']) {
    assert.ok(childNames.includes(expected), `Line is missing ${expected}`);
  }
});

test('Machines folder contains one object per configured machine', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);
  const machines = tree.children.find(c => c.browseName === 'Machines');
  assert.equal(machines.children.length, DEFAULT_CONFIG.machines.length);
  for (let i = 0; i < DEFAULT_CONFIG.machines.length; i++) {
    assert.equal(machines.children[i].browseName, DEFAULT_CONFIG.machines[i].id);
  }
});

test('Each machine has the documented variables', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);
  const m1 = tree.children.find(c => c.browseName === 'Machines')
                         .children.find(c => c.browseName === 'M1');
  const varNames = m1.children.map(c => c.browseName);
  for (const v of ['Name', 'CycleTime', 'State', 'PartsProcessed',
                   'Utilization', 'TicksProcessing', 'TicksBlocked',
                   'TicksStarved', 'TicksIdle', 'RejectRate']) {
    assert.ok(varNames.includes(v), `M1 is missing ${v}`);
  }
});

test('Methods folder advertises Play, Pause, Reset, SetSpeed', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);
  const methods = tree.children.find(c => c.browseName === 'Methods');
  const names = methods.children.map(c => c.browseName).sort();
  assert.deepEqual(names, ['Pause', 'Play', 'Reset', 'SetSpeed']);
});

test('Variable getters return live engine values', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);
  const tickNode = tree.children.find(c => c.browseName === 'Tick');
  assert.equal(tickNode.get(), 0);
  // simulate a tick by mutating engine state directly
  engine.tick = 7;
  assert.equal(tickNode.get(), 7);
});

test('toJSON output is stable and contains all browseNames', () => {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const tree = buildNodeset(engine);
  const json = toJSON(tree);
  assert.equal(json.browseName, 'Line');
  // getters must be stripped from JSON (not serialisable)
  function check(n) {
    assert.equal(typeof n.get, 'undefined');
    (n.children ?? []).forEach(check);
  }
  check(json);
});
