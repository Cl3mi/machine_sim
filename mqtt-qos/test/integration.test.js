import { test } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { BROKER_URL } from '../common.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Establish a durable session subscribed at `qos`, then disconnect.
async function primeSession(clientId, topic, qos) {
  const c = await mqtt.connectAsync(BROKER_URL, { clientId, clean: false });
  await c.subscribeAsync(topic, { qos });
  await c.endAsync();
}

// Publish one message while nobody is connected on that session.
async function publishOffline(topic, qos, payload) {
  const p = await mqtt.connectAsync(BROKER_URL, { clientId: `pub-${topic}` });
  await p.publishAsync(topic, payload, { qos });
  await p.endAsync();
}

// Reconnect the durable session and collect messages for `waitMs`.
function collectOnReconnect(clientId, topic, qos, waitMs) {
  return new Promise((resolve) => {
    const got = [];
    const c = mqtt.connect(BROKER_URL, { clientId, clean: false });
    c.on('message', (t, m) => got.push(m.toString()));
    c.on('connect', () => c.subscribe(topic, { qos }));
    setTimeout(async () => { await c.endAsync(); resolve(got); }, waitMs);
  });
}

test('QoS 0: message published while offline is LOST', async () => {
  const topic = `test/qos0/${Date.now()}`;
  await primeSession('it-sub-qos0', topic, 0);
  await publishOffline(topic, 0, 'lost?');
  const got = await collectOnReconnect('it-sub-qos0', topic, 0, 1200);
  assert.deepEqual(got, [], 'QoS 0 offline message should not be redelivered');
});

test('QoS 1: message published while offline IS redelivered', async () => {
  const topic = `test/qos1/${Date.now()}`;
  await primeSession('it-sub-qos1', topic, 1);
  await publishOffline(topic, 1, 'kept!');
  const got = await collectOnReconnect('it-sub-qos1', topic, 1, 1200);
  assert.deepEqual(got, ['kept!'], 'QoS 1 offline message should be redelivered on reconnect');
});
