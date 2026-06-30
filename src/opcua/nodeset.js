/**
 * nodeset.js
 * Declarative description of the OPC UA address space exposed by the
 * plant engine. Pure data + getters; no dependency on node-opcua.
 *
 * Each node:
 *   { browseName, kind: 'object'|'variable'|'method'|'folder',
 *     dataType?, get?, children?, inputArgs?, outputArgs? }
 *
 * Variable getters close over a SimulationEngine instance and return the
 * current live value. Methods are bound by src/opcua/server.js to
 * controls.js wrappers (this file does not import controls).
 */

import { calculateMetrics } from '../metrics/collector.js';

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function bottleneckId(engine) {
  const metrics = calculateMetrics(engine.getState());
  const primary = metrics.machines.find(m => m.isPrimaryConstraint)
               ?? metrics.machines.find(m => m.bottleneck);
  return primary?.id ?? '';
}

function machineUtilization(m) {
  const total = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
  return total > 0 ? m.ticksProcessing / total : 0;
}

function avgLeadTime(engine) {
  const recent = engine.sink?.completedParts?.slice(-20) ?? [];
  if (recent.length === 0) return 0;
  return sum(recent.map(p => p.completedAt - p.createdAt)) / recent.length;
}

function throughput(engine) {
  const t = engine.tick;
  if (t <= 0) return 0;
  // parts per "minute" (treating each tick as 1 simulated second is fine for the demo)
  return (engine.sink.partsReceived / t) * 60;
}

function machineNode(engine, machineId) {
  const get = () => engine.machines.find(m => m.id === machineId);
  return {
    browseName: machineId,
    kind: 'object',
    children: [
      { browseName: 'Name',            kind: 'variable', dataType: 'String', get: () => get().name },
      { browseName: 'CycleTime',       kind: 'variable', dataType: 'UInt32', get: () => get().cycleTime },
      { browseName: 'State',           kind: 'variable', dataType: 'String', get: () => get().state },
      { browseName: 'PartsProcessed',  kind: 'variable', dataType: 'UInt32', get: () => get().partsProcessed },
      { browseName: 'Utilization',     kind: 'variable', dataType: 'Double', get: () => machineUtilization(get()) },
      { browseName: 'TicksProcessing', kind: 'variable', dataType: 'UInt32', get: () => get().ticksProcessing },
      { browseName: 'TicksBlocked',    kind: 'variable', dataType: 'UInt32', get: () => get().ticksBlocked },
      { browseName: 'TicksStarved',    kind: 'variable', dataType: 'UInt32', get: () => get().ticksStarved },
      { browseName: 'TicksIdle',       kind: 'variable', dataType: 'UInt32', get: () => get().ticksIdle },
      { browseName: 'RejectRate',      kind: 'variable', dataType: 'Double', get: () => get().rejectRate },
    ],
  };
}

function bufferNode(engine, bufferId) {
  const get = () => engine.buffers.find(b => b.id === bufferId);
  return {
    browseName: bufferId,
    kind: 'object',
    children: [
      { browseName: 'Capacity',     kind: 'variable', dataType: 'UInt32', get: () => get().capacity },
      { browseName: 'Level',        kind: 'variable', dataType: 'UInt32', get: () => get().parts.length },
      { browseName: 'Fill',         kind: 'variable', dataType: 'Double', get: () => {
          const b = get();
          return b.capacity > 0 ? b.parts.length / b.capacity : 0;
      }},
      { browseName: 'AvgWaitTicks', kind: 'variable', dataType: 'Double', get: () => {
          const b = get();
          return b.totalPartsOut > 0 ? b.totalWaitTicks / b.totalPartsOut : 0;
      }},
    ],
  };
}

export function buildNodeset(engine) {
  return {
    browseName: 'Line',
    kind: 'object',
    children: [
      { browseName: 'Throughput',   kind: 'variable', dataType: 'Double', get: () => throughput(engine) },
      { browseName: 'AvgLeadTime',  kind: 'variable', dataType: 'Double', get: () => avgLeadTime(engine) },
      { browseName: 'Tick',         kind: 'variable', dataType: 'UInt32', get: () => engine.tick },
      { browseName: 'State',        kind: 'variable', dataType: 'String', get: () => engine.getState().running ? 'RUNNING' : 'PAUSED' },
      { browseName: 'Speed',        kind: 'variable', dataType: 'Double', get: () => engine.getState().speed },
      { browseName: 'BottleneckId', kind: 'variable', dataType: 'String', get: () => bottleneckId(engine) },
      {
        browseName: 'Source', kind: 'object',
        children: [
          { browseName: 'TotalGenerated', kind: 'variable', dataType: 'UInt32', get: () => engine.source.totalGenerated },
          { browseName: 'MaterialStock',  kind: 'variable', dataType: 'UInt32', get: () => engine.source.materialStock },
          { browseName: 'Interval',       kind: 'variable', dataType: 'UInt32', get: () => engine.source.interval },
        ],
      },
      {
        browseName: 'Sink', kind: 'object',
        children: [
          { browseName: 'PartsReceived',  kind: 'variable', dataType: 'UInt32', get: () => engine.sink.partsReceived },
          { browseName: 'ScrapReceived',  kind: 'variable', dataType: 'UInt32', get: () => engine.scrapSink.partsReceived },
        ],
      },
      {
        browseName: 'Machines', kind: 'folder',
        children: engine.machines.map(m => machineNode(engine, m.id)),
      },
      {
        browseName: 'Buffers', kind: 'folder',
        children: engine.buffers.map(b => bufferNode(engine, b.id)),
      },
      {
        browseName: 'Methods', kind: 'folder',
        children: [
          { browseName: 'Play',     kind: 'method', inputArgs: [],                                outputArgs: [] },
          { browseName: 'Pause',    kind: 'method', inputArgs: [],                                outputArgs: [] },
          { browseName: 'Reset',    kind: 'method', inputArgs: [],                                outputArgs: [] },
          { browseName: 'SetSpeed', kind: 'method',
            inputArgs:  [{ name: 'multiplier', dataType: 'Double' }],
            outputArgs: [] },
        ],
      },
    ],
  };
}

// Strip non-serialisable fields (the get() closures) for the JSON deliverable.
export function toJSON(node) {
  const out = { browseName: node.browseName, kind: node.kind };
  if (node.dataType) out.dataType = node.dataType;
  if (node.inputArgs)  out.inputArgs  = node.inputArgs;
  if (node.outputArgs) out.outputArgs = node.outputArgs;
  if (node.children) out.children = node.children.map(toJSON);
  return out;
}
