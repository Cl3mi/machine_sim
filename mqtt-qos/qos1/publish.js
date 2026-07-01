// QoS 1 publisher — "at least once". Each PUBLISH is confirmed by a PUBACK.
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake } from '../common.js';

const QOS = 1;
const TOPIC = TOPICS[QOS];
const COUNT = Number(process.argv[2] || 10);
const INTERVAL = Number(process.argv[3] || 1000);

const client = mqtt.connect(BROKER_URL, { clientId: `pub-qos1-${process.pid}` });
logHandshake(client, 'pub-qos1');

client.on('connect', async () => {
  log('pub-qos1', `connected to ${BROKER_URL}, publishing ${COUNT} msgs to "${TOPIC}"`);
  for (let seq = 1; seq <= COUNT; seq++) {
    const payload = JSON.stringify({ seq, ts: Date.now() });
    await client.publishAsync(TOPIC, payload, { qos: QOS }); // resolves on PUBACK
    log('pub-qos1', `published seq=${seq} (PUBACK received)`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  log('pub-qos1', 'done');
  await client.endAsync();
});

client.on('error', (e) => log('pub-qos1', 'ERROR', e.message));
