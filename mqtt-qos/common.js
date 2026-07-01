import mqtt from 'mqtt';

// Broker URL is overridable via env; defaults to the local Docker broker.
export const BROKER_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';

// Topics are fixed per QoS level so pub/sub pairs line up.
export const TOPICS = { 0: 'demo/qos0', 1: 'demo/qos1', 2: 'demo/qos2' };

// Timestamped logger for a nice, ordered trace.
export function log(role, ...args) {
  const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`${t} [${role}]`, ...args);
}

// The control packets that make the QoS handshake visible.
const HANDSHAKE = new Set(['publish', 'puback', 'pubrec', 'pubrel', 'pubcomp']);

// Attach packet-level logging so the QoS handshake is observable:
//   QoS0 -> publish
//   QoS1 -> publish, puback
//   QoS2 -> publish, pubrec, pubrel, pubcomp
export function logHandshake(client, role) {
  client.on('packetsend', (p) => {
    if (HANDSHAKE.has(p.cmd)) log(role, `--> ${p.cmd.toUpperCase()}${p.messageId ? ' id=' + p.messageId : ''}`);
  });
  client.on('packetreceive', (p) => {
    if (HANDSHAKE.has(p.cmd)) log(role, `<-- ${p.cmd.toUpperCase()}${p.messageId ? ' id=' + p.messageId : ''}`);
  });
}

// Tracks received sequence numbers to reveal loss (gaps) and duplicates.
export class SeqTracker {
  constructor() {
    this.seen = new Map();   // seq -> count
    this.received = 0;       // total messages incl. duplicates
    this.highestSeq = 0;
  }
  record(seq) {
    this.received += 1;
    this.seen.set(seq, (this.seen.get(seq) || 0) + 1);
    if (seq > this.highestSeq) this.highestSeq = seq;
  }
  summary() {
    let duplicates = 0;
    for (const count of this.seen.values()) duplicates += count - 1;
    const missing = [];
    for (let s = 1; s <= this.highestSeq; s++) if (!this.seen.has(s)) missing.push(s);
    return {
      received: this.received,
      unique: this.seen.size,
      duplicates,
      missing,
      highestSeq: this.highestSeq,
    };
  }
}

// Pretty-print a subscriber summary block.
export function printSummary(role, tracker) {
  const s = tracker.summary();
  log(role, '================ SUMMARY ================');
  log(role, `received (incl. dups): ${s.received}`);
  log(role, `unique messages:       ${s.unique}`);
  log(role, `duplicates:            ${s.duplicates}`);
  log(role, `missing seq (lost):    ${s.missing.length ? s.missing.join(', ') : 'none'}`);
  log(role, '=========================================');
}
