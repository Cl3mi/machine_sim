// QoS 1 subscriber — "at least once". Persistent session (clean:false) so
// messages sent while offline are redelivered on reconnect.
//
// Effects shown:
//  - Offline messages ARE redelivered (unlike QoS 0).
//  - DUPLICATES are possible. Run with `--kill-before-ack` to force one:
//    on the first message we destroy the socket before the PUBACK is sent,
//    so the broker redelivers it with dup=true on the next run.
import mqtt from 'mqtt';
import { BROKER_URL, TOPICS, log, logHandshake, SeqTracker, printSummary } from '../common.js';

const QOS = 1;
const TOPIC = TOPICS[QOS];
const KILL_BEFORE_ACK = process.argv.includes('--kill-before-ack');
const tracker = new SeqTracker();

const client = mqtt.connect(BROKER_URL, { clientId: 'sub-qos1', clean: false });
logHandshake(client, 'sub-qos1');

let killed = false;
client.on('message', (topic, payload, packet) => {
  const { seq } = JSON.parse(payload.toString());
  tracker.record(seq);
  log('sub-qos1', `recv seq=${seq} qos=${packet.qos} dup=${packet.dup}`);
  if (KILL_BEFORE_ACK && !killed) {
    killed = true;
    log('sub-qos1', '--kill-before-ack: destroying socket BEFORE PUBACK (forces redelivery)');
    client.stream.destroy(); // hard TCP close before the auto-PUBACK flushes
    printSummary('sub-qos1', tracker);
    process.exit(0);
  }
});

client.on('connect', (connack) => {
  log('sub-qos1', `connected, sessionPresent=${connack.sessionPresent}`);
  client.subscribe(TOPIC, { qos: QOS }, (err) => {
    if (err) log('sub-qos1', 'subscribe error', err.message);
    else log('sub-qos1', `subscribed to "${TOPIC}" at qos ${QOS}. Ctrl-C for summary.`);
  });
});

client.on('error', (e) => log('sub-qos1', 'ERROR', e.message));

process.on('SIGINT', async () => {
  printSummary('sub-qos1', tracker);
  await client.endAsync();
  process.exit(0);
});
