/**
 * opcua-client-demo.js
 * Connects to the PlantSim OPC UA server, subscribes to a handful of
 * nodes, and prints values as they change. Doubles as the "Programm-Code"
 * demonstration of OPC UA client/server communication for the lecturer.
 *
 * Usage: node tools/opcua-client-demo.js [opc.tcp://host:port]
 */

import {
  OPCUAClient, AttributeIds, TimestampsToReturn,
  ClientSubscription, ClientMonitoredItem,
} from 'node-opcua';

const endpoint = process.argv[2] ?? 'opc.tcp://localhost:4840';

const NODES = [
  'ns=1;s=Line.Tick',
  'ns=1;s=Line.Throughput',
  'ns=1;s=Line.Machines.M1.State',
  'ns=1;s=Line.Machines.M2.State',
  'ns=1;s=Line.Buffers.BUF1.Level',
  'ns=1;s=Line.Sink.PartsReceived',
];

async function main() {
  const client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect(endpoint);
  console.log(`connected to ${endpoint}`);

  const session = await client.createSession();
  const sub = ClientSubscription.create(session, {
    requestedPublishingInterval: 500,
    requestedLifetimeCount:      100,
    requestedMaxKeepAliveCount:  10,
    publishingEnabled:           true,
    priority:                    10,
  });

  for (const nodeId of NODES) {
    const item = ClientMonitoredItem.create(
      sub,
      { nodeId, attributeId: AttributeIds.Value },
      { samplingInterval: 250, queueSize: 10, discardOldest: true },
      TimestampsToReturn.Both,
    );
    item.on('changed', (dv) => {
      console.log(`${new Date().toISOString()}  ${nodeId.padEnd(40)} = ${dv.value.value}`);
    });
  }

  console.log('subscribed; press Ctrl-C to exit');
  process.on('SIGINT', async () => {
    console.log('\nshutting down client');
    await sub.terminate();
    await session.close();
    await client.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
