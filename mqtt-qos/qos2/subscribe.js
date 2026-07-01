// QoS 2 subscriber — "exactly once". Persistent session (clean:false).
//
// Effects shown:
//  - Offline messages ARE redelivered (like QoS 1).
//  - NO duplicates: even if we destroy the socket mid-handshake
//    (--kill-mid-handshake), the broker redelivers the PUBLISH but mqtt.js
//    dedupes it via the message id, so the app sees each message exactly once.
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake, SeqTracker, printSummary } from '../common.js';

const QOS = 2;
const TOPIC = TOPICS[QOS];
const KILL_MID = process.argv.includes('--kill-mid-handshake');
const tracker = new SeqTracker();

const client = mqtt.connect(BROKER_URL, { clientId: 'sub-qos2', clean: false });
logHandshake(client, 'sub-qos2');

let killed = false;
client.on('message', (topic, payload, packet) => {
  const { seq } = JSON.parse(payload.toString());
  tracker.record(seq);
  log('sub-qos2', `recv seq=${seq} qos=${packet.qos} dup=${packet.dup}`);
  if (KILL_MID && !killed) {
    killed = true;
    log('sub-qos2', '--kill-mid-handshake: destroying socket mid-handshake (still exactly-once on rerun)');
    client.stream.destroy();
    printSummary('sub-qos2', tracker);
    process.exit(0);
  }
});

client.on('connect', (connack) => {
  log('sub-qos2', `connected, sessionPresent=${connack.sessionPresent}`);
  client.subscribe(TOPIC, { qos: QOS }, (err) => {
    if (err) log('sub-qos2', 'subscribe error', err.message);
    else log('sub-qos2', `subscribed to "${TOPIC}" at qos ${QOS}. Ctrl-C for summary.`);
  });
});

client.on('error', (e) => log('sub-qos2', 'ERROR', e.message));

process.on('SIGINT', async () => {
  printSummary('sub-qos2', tracker);
  await client.endAsync();
  process.exit(0);
});
