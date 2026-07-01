// QoS 2 publisher — "exactly once". Four-way handshake:
// PUBLISH -> PUBREC -> PUBREL -> PUBCOMP.
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake } from '../common.js';

const QOS = 2;
const TOPIC = TOPICS[QOS];
const COUNT = Number(process.argv[2] || 10);
const INTERVAL = Number(process.argv[3] || 1000);

const client = mqtt.connect(BROKER_URL, { clientId: `pub-qos2-${process.pid}` });
logHandshake(client, 'pub-qos2');

client.on('connect', async () => {
  log('pub-qos2', `connected to ${BROKER_URL}, publishing ${COUNT} msgs to "${TOPIC}"`);
  for (let seq = 1; seq <= COUNT; seq++) {
    const payload = JSON.stringify({ seq, ts: Date.now() });
    await client.publishAsync(TOPIC, payload, { qos: QOS }); // resolves on PUBCOMP
    log('pub-qos2', `published seq=${seq} (PUBCOMP received)`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  log('pub-qos2', 'done');
  await client.endAsync();
});

client.on('error', (e) => log('pub-qos2', 'ERROR', e.message));
