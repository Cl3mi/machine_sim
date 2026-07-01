// QoS 2 subscriber — "exactly once". Persistent session (clean:false).
//
// Effects shown:
//  - Offline messages ARE redelivered (like QoS 1).
//  - NO duplicates: run with `--kill-mid-handshake` to destroy the socket right
//    after the first message. mqtt.js auto-reconnects and the QoS 2 handshake
//    resumes, but the message is NOT handed to the app a second time — so the
//    Ctrl-C summary stays at exactly one delivery, duplicates: 0. Contrast this
//    with the QoS 1 --kill-before-ack run, which DOES produce a duplicate.
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
  let seq;
  try {
    ({ seq } = JSON.parse(payload.toString()));
  } catch {
    log('sub-qos2', `ignoring non-JSON message: ${payload.toString()}`);
    return;
  }
  tracker.record(seq);
  log('sub-qos2', `recv seq=${seq} qos=${packet.qos} dup=${packet.dup}`);
  if (KILL_MID && !killed) {
    killed = true;
    log('sub-qos2', '--kill-mid-handshake: destroying socket mid-handshake, then auto-reconnecting');
    // Hard TCP close mid-handshake. mqtt.js auto-reconnects and the QoS 2
    // handshake resumes, but the message is NOT delivered to the app again.
    // Press Ctrl-C to confirm exactly one delivery (duplicates: 0).
    client.stream.destroy();
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
