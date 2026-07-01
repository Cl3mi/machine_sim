// QoS 0 subscriber — "at most once". Uses a PERSISTENT session (clean:false)
// so we can show that even so, QoS 0 messages sent while offline are LOST.
//
// Demo: start this -> Ctrl-C -> run publish.js -> restart this.
// The messages published while offline never arrive (gaps in the summary).
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake, SeqTracker, printSummary } from '../common.js';

const QOS = 0;
const TOPIC = TOPICS[QOS];
const tracker = new SeqTracker();

// Fixed clientId + clean:false = durable session (see spec).
const client = mqtt.connect(BROKER_URL, { clientId: 'sub-qos0', clean: false });
logHandshake(client, 'sub-qos0');

// Attach the message handler synchronously (before CONNACK) so queued
// messages delivered right after reconnect are not missed.
client.on('message', (topic, payload, packet) => {
  let seq;
  try {
    ({ seq } = JSON.parse(payload.toString()));
  } catch {
    log('sub-qos0', `ignoring non-JSON message: ${payload.toString()}`);
    return;
  }
  tracker.record(seq);
  log('sub-qos0', `recv seq=${seq} qos=${packet.qos} dup=${packet.dup}`);
});

client.on('connect', (connack) => {
  log('sub-qos0', `connected, sessionPresent=${connack.sessionPresent}`);
  client.subscribe(TOPIC, { qos: QOS }, (err) => {
    if (err) log('sub-qos0', 'subscribe error', err.message);
    else log('sub-qos0', `subscribed to "${TOPIC}" at qos ${QOS}. Ctrl-C for summary.`);
  });
});

client.on('error', (e) => log('sub-qos0', 'ERROR', e.message));

process.on('SIGINT', async () => {
  printSummary('sub-qos0', tracker);
  await client.endAsync();
  process.exit(0);
});
