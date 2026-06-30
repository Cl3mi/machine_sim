import test from 'node:test';
import assert from 'node:assert/strict';
import { OPCUAClient, AttributeIds, TimestampsToReturn, ClientSubscription, ClientMonitoredItem } from 'node-opcua';

import { SimulationEngine } from '../../simulation/engine.js';
import { DEFAULT_CONFIG }    from '../../simulation/config.js';
import { startOpcuaServer }  from '../server.js';

const TEST_PORT = 14840; // non-default to avoid clashing with a running app

async function withServer(fn) {
  const engine = new SimulationEngine(DEFAULT_CONFIG);
  const server = await startOpcuaServer({ engine, port: TEST_PORT });
  try {
    await fn(engine, server);
  } finally {
    await server.shutdown(0);
  }
}

async function connectClient() {
  const client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect(`opc.tcp://localhost:${TEST_PORT}`);
  const session = await client.createSession();
  return { client, session };
}

test('server exposes Line.Tick and read returns the engine tick value', async () => {
  await withServer(async (engine) => {
    engine.tick = 42;
    const { client, session } = await connectClient();
    try {
      const dv = await session.read({
        nodeId: 'ns=1;s=Line.Tick',
        attributeId: AttributeIds.Value,
      });
      assert.equal(dv.value.value, 42);
    } finally {
      await session.close();
      await client.disconnect();
    }
  });
});

test('subscription delivers updates when engine state mutates', async () => {
  await withServer(async (engine) => {
    const { client, session } = await connectClient();
    try {
      const sub = ClientSubscription.create(session, {
        requestedPublishingInterval: 100,
        requestedLifetimeCount: 100,
        requestedMaxKeepAliveCount: 10,
        publishingEnabled: true,
        priority: 10,
      });
      const item = ClientMonitoredItem.create(
        sub,
        { nodeId: 'ns=1;s=Line.Tick', attributeId: AttributeIds.Value },
        { samplingInterval: 50, queueSize: 10, discardOldest: true },
        TimestampsToReturn.Both,
      );

      const received = [];
      item.on('changed', (dv) => received.push(Number(dv.value.value)));

      // Mutate the engine a couple of times
      await new Promise(r => setTimeout(r, 200));
      engine.tick = 5;
      await new Promise(r => setTimeout(r, 200));
      engine.tick = 11;
      await new Promise(r => setTimeout(r, 300));

      assert.ok(received.includes(5),  `expected 5 in ${received}`);
      assert.ok(received.includes(11), `expected 11 in ${received}`);

      await sub.terminate();
    } finally {
      await session.close();
      await client.disconnect();
    }
  });
});
