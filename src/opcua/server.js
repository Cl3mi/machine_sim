import {
  OPCUAServer,
  MessageSecurityMode,
  SecurityPolicy,
  DataType,
  Variant,
} from 'node-opcua';
import { calculateMetrics } from '../metrics/collector.js';

const TCP_PORT = parseInt(process.env.OPCUA_TCP_PORT ?? '4840');

export async function startOpcUaServer(engine) {
  const server = new OPCUAServer({
    port: TCP_PORT,
    serverInfo: {
      applicationName: { text: 'PlantSim PoC' },
      applicationUri: 'urn:PlantSim:Server',
      productUri: 'PlantSim',
    },
    securityModes: [MessageSecurityMode.None],
    securityPolicies: [SecurityPolicy.None],
    allowAnonymous: true,
  });

  await server.initialize();

  const vars = _buildAddressSpace(server.engine.addressSpace, engine.getState());

  await server.start();
  console.log(`OPC-UA TCP listening on opc.tcp://127.0.0.1:${TCP_PORT}`);

  const onTick = (state) => _updateNodes(vars, state);
  engine.on('tick', onTick);
  const cleanup = () => engine.off('tick', onTick);
  process.once('SIGTERM', cleanup);
  process.once('SIGINT',  cleanup);

  return server;
}

function _buildAddressSpace(addressSpace, state) {
  const ns  = addressSpace.getOwnNamespace();
  const obj = addressSpace.rootFolder.objects;

  const plantSim  = ns.addFolder(obj,       { browseName: 'PlantSim'    });
  const machinesF = ns.addFolder(plantSim,  { browseName: 'Machines'    });
  const buffersF  = ns.addFolder(plantSim,  { browseName: 'Buffers'     });
  const simF      = ns.addFolder(plantSim,  { browseName: 'Simulation'  });

  const vars = { machines: {}, buffers: {}, sim: {} };

  for (const m of state.machines) {
    const f  = ns.addFolder(machinesF, { browseName: m.id });
    const mv = {
      state:           _addVar(ns, f, 'state',           DataType.String,  m.state),
      cycleTime:       _addVar(ns, f, 'cycleTime',       DataType.UInt32,  m.cycleTime),
      partsProcessed:  _addVar(ns, f, 'partsProcessed',  DataType.UInt32,  m.partsProcessed),
      ticksProcessing: _addVar(ns, f, 'ticksProcessing', DataType.UInt32,  m.ticksProcessing),
      ticksBlocked:    _addVar(ns, f, 'ticksBlocked',    DataType.UInt32,  m.ticksBlocked),
      ticksStarved:    _addVar(ns, f, 'ticksStarved',    DataType.UInt32,  m.ticksStarved),
    };
    if (m.rejectRate !== undefined) {
      mv.rejectRate = _addVar(ns, f, 'rejectRate', DataType.Double, m.rejectRate);
    }
    vars.machines[m.id] = mv;
  }

  for (const b of state.buffers) {
    const f = ns.addFolder(buffersF, { browseName: b.id });
    vars.buffers[b.id] = {
      currentParts: _addVar(ns, f, 'currentParts', DataType.UInt32, b.load),
      capacity:     _addVar(ns, f, 'capacity',     DataType.UInt32, b.capacity),
    };
  }

  vars.sim.tick         = _addVar(ns, simF, 'tick',         DataType.UInt32,  state.tick);
  vars.sim.running      = _addVar(ns, simF, 'running',      DataType.Boolean, state.running);
  vars.sim.throughput   = _addVar(ns, simF, 'throughput',   DataType.Double,  0);
  vars.sim.bottleneckId = _addVar(ns, simF, 'bottleneckId', DataType.String,  '');

  return vars;
}

function _addVar(ns, parent, name, dataType, initialValue) {
  const v = ns.addVariable({ componentOf: parent, browseName: name, dataType });
  const fallback = dataType === DataType.String ? '' : dataType === DataType.Boolean ? false : 0;
  v.setValueFromSource(new Variant({ dataType, value: initialValue ?? fallback }));
  return v;
}

function _updateNodes(vars, state) {
  for (const m of state.machines) {
    const mv = vars.machines[m.id];
    if (!mv) continue;
    mv.state.setValueFromSource(new Variant({ dataType: DataType.String,  value: m.state }));
    mv.cycleTime.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: m.cycleTime }));
    mv.partsProcessed.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: m.partsProcessed }));
    mv.ticksProcessing.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: m.ticksProcessing }));
    mv.ticksBlocked.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: m.ticksBlocked }));
    mv.ticksStarved.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: m.ticksStarved }));
    if (mv.rejectRate) {
      mv.rejectRate.setValueFromSource(new Variant({ dataType: DataType.Double, value: m.rejectRate ?? 0 }));
    }
  }
  for (const b of state.buffers) {
    const bv = vars.buffers[b.id];
    if (!bv) continue;
    bv.currentParts.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: b.load }));
  }
  vars.sim.tick.setValueFromSource(new Variant({ dataType: DataType.UInt32,   value: state.tick }));
  vars.sim.running.setValueFromSource(new Variant({ dataType: DataType.Boolean, value: state.running }));
  const metrics = calculateMetrics(state);
  vars.sim.throughput.setValueFromSource(new Variant({ dataType: DataType.Double, value: metrics.throughput }));
  const bottleneck = metrics.machines.find((m) => m.bottleneck);
  vars.sim.bottleneckId.setValueFromSource(new Variant({ dataType: DataType.String, value: bottleneck?.id ?? '' }));
}
