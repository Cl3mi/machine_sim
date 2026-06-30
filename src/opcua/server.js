/**
 * server.js (opcua)
 * Boots an OPC UA server backed by a single SimulationEngine instance
 * (the "plant engine"). Variables are bound to live engine getters; the
 * server samples those getters in response to client MonitoredItem
 * activity, so we do not need a per-tick push.
 *
 * Security: SecurityPolicy.None + anonymous. Lab use only.
 */

import {
  OPCUAServer, SecurityPolicy, MessageSecurityMode, Variant, DataType, StatusCodes,
} from 'node-opcua';
import { buildNodeset } from './nodeset.js';
import * as controls from '../controls.js';

const NAMESPACE_URI = 'urn:mci:plantsim';

const dataTypeMap = {
  Double: DataType.Double,
  UInt32: DataType.UInt32,
  String: DataType.String,
};

function nodeIdFor(path) {
  return `ns=1;s=${path.join('.')}`;
}

function installVariable(ns, parent, node, path) {
  const dt = dataTypeMap[node.dataType];
  if (!dt) throw new Error(`Unsupported dataType ${node.dataType} for ${path.join('.')}`);
  ns.addVariable({
    componentOf:              parent,
    browseName:               node.browseName,
    nodeId:                   nodeIdFor(path),
    dataType:                 node.dataType,
    minimumSamplingInterval:  50,
    value: {
      get: () => new Variant({ dataType: dt, value: node.get() }),
    },
  });
}

function installObject(ns, parent, node, path, useOrganizedBy = false) {
  const parentKey = useOrganizedBy ? 'organizedBy' : 'componentOf';
  return ns.addObject({
    [parentKey]: parent,
    browseName:  node.browseName,
    nodeId:      nodeIdFor(path),
  });
}

function installFolder(ns, parent, node, path) {
  // addFolder() only accepts FolderType parents; for folders nested inside
  // objects (e.g. Line/Machines) we use addObject with typeDefinition instead.
  return ns.addObject({
    componentOf:    parent,
    browseName:     node.browseName,
    nodeId:         nodeIdFor(path),
    typeDefinition: 'FolderType',
  });
}

function installMethod(ns, parent, node, path, engine) {
  const dt = (a) => dataTypeMap[a.dataType] ?? DataType.Double;

  const method = ns.addMethod(parent, {
    browseName: node.browseName,
    nodeId:     nodeIdFor(path),
    inputArguments:  (node.inputArgs  ?? []).map(a => ({ name: a.name, dataType: dt(a) })),
    outputArguments: (node.outputArgs ?? []).map(a => ({ name: a.name, dataType: dt(a) })),
  });

  method.bindMethod((inputArguments, _context, callback) => {
    try {
      switch (node.browseName) {
        case 'Play':     controls.play(engine);  break;
        case 'Pause':    controls.pause(engine); break;
        case 'Reset':    controls.reset(engine); break;
        case 'SetSpeed': {
          const m = Number(inputArguments[0]?.value);
          controls.setSpeed(engine, m);
          break;
        }
        default:
          return callback(null, { statusCode: StatusCodes.BadNotImplemented });
      }
      callback(null, { statusCode: StatusCodes.Good, outputArguments: [] });
    } catch (err) {
      callback(null, { statusCode: StatusCodes.BadInvalidArgument });
    }
  });
}

function installNode(ns, parent, node, path, engine) {
  const childPath = [...path, node.browseName];
  if (node.kind === 'variable') return installVariable(ns, parent, node, childPath);
  if (node.kind === 'method')   return installMethod(ns, parent, node, childPath, engine);

  // Direct children of rootFolder.objects must use organizedBy, not componentOf.
  const topLevel = path.length === 0;
  const installed =
    node.kind === 'folder' ? installFolder(ns, parent, node, childPath) :
    node.kind === 'object' ? installObject(ns, parent, node, childPath, topLevel) :
    (() => { throw new Error(`Unknown node kind ${node.kind}`); })();

  for (const child of node.children ?? []) {
    installNode(ns, installed, child, childPath, engine);
  }
}

export async function startOpcuaServer({ engine, port = 4840 }) {
  // Setting applicationUri to NAMESPACE_URI causes the server engine to
  // register that URI as namespace index 1, so node IDs of the form
  // "ns=1;s=Line.Tick" resolve correctly from clients.
  const server = new OPCUAServer({
    port,
    resourcePath: '/UA/PlantSim',
    buildInfo: {
      productName: 'PlantSim',
      buildNumber: '1',
      buildDate:   new Date(),
    },
    serverInfo: {
      applicationUri: NAMESPACE_URI,
    },
    securityPolicies: [SecurityPolicy.None],
    securityModes:    [MessageSecurityMode.None],
    allowAnonymous:   true,
  });

  await server.initialize();

  const addressSpace = server.engine.addressSpace;
  const ns = addressSpace.getNamespace(NAMESPACE_URI);
  if (!ns) {
    throw new Error(
      `Namespace ${NAMESPACE_URI} not registered. ` +
      `Check that serverInfo.applicationUri is set to the same URI before calling initialize().`
    );
  }

  const tree = buildNodeset(engine);
  installNode(ns, addressSpace.rootFolder.objects, tree, [], engine);

  await server.start();
  return server;
}
