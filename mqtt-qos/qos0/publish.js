// QoS 0 publisher — "fire and forget". No PUBACK, no retransmission.
// Sends COUNT sequence-numbered messages, one per INTERVAL ms.
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake } from '../common.js';

const QOS = 0;
const TOPIC = TOPICS[QOS];
const COUNT = Number(process.argv[2] || 10);
const INTERVAL = Number(process.argv[3] || 1000);

const client = mqtt.connect(BROKER_URL, { clientId: `pub-qos0-${process.pid}` });
logHandshake(client, 'pub-qos0');

client.on('connect', async () => {
  log('pub-qos0', `connected to ${BROKER_URL}, publishing ${COUNT} msgs to "${TOPIC}"`);
  for (let seq = 1; seq <= COUNT; seq++) {
    const payload = JSON.stringify({ seq, ts: Date.now() });
    await client.publishAsync(TOPIC, payload, { qos: QOS });
    log('pub-qos0', `published seq=${seq}`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  log('pub-qos0', 'done');
  await client.endAsync();
});

client.on('error', (e) => log('pub-qos0', 'ERROR', e.message));
