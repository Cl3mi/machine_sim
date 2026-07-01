# MQTT QoS Demonstration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build six standalone Node.js programs (publish + subscribe per MQTT QoS level 0/1/2) plus a local Mosquitto broker that make the effects of each QoS level observable: message loss (QoS 0), duplicates (QoS 1), and exactly-once delivery (QoS 2).

**Architecture:** A self-contained `mqtt-qos/` directory, fully independent of the PlantSim simulation code. A shared `common.js` provides connection, timestamped logging, packet-handshake logging, and a summary helper. Each QoS level has its own `publish.js` (sends sequence-numbered messages) and `subscribe.js` (tracks gaps/duplicates via sequence numbers, uses a persistent session, prints a summary on Ctrl-C). A local Eclipse Mosquitto broker (own docker-compose file, `persistence true`) makes the offline-queueing effects reproducible.

**Tech Stack:** Node.js (ES modules), `mqtt` (mqtt.js 5.x), Eclipse Mosquitto 2.x via Docker. Node's built-in `node:test` for the one automated integration test.

**Verification note:** All broker behaviours below were empirically verified against `eclipse-mosquitto:2` + `mqtt@5.15.1` during design (see spec `docs/superpowers/specs/2026-07-01-mqtt-qos-demo-design.md`). Key facts baked into this plan:
- Persistent session = `{ clientId: <fixed>, clean: false }`; reconnect reports `connack.sessionPresent === true`.
- QoS 1/2 messages published while the subscriber is offline are queued and redelivered on reconnect; QoS 0 messages are **not** queued (lost).
- The `message` handler MUST be attached synchronously right after `mqtt.connect(...)` (do NOT `await connectAsync` then attach) — otherwise queued messages delivered immediately after CONNACK are missed.
- Forcing a QoS 1 duplicate: on receipt, call `client.stream.destroy()` before the auto-PUBACK flushes; the broker redelivers with `dup === true` on reconnect. (`manualAcks` no longer exists in mqtt.js 5.x.)
- `packet.cmd` values for handshake logging: `publish`, `puback`, `pubrec`, `pubrel`, `pubcomp`.

---

## File Structure

- `mqtt-qos/package.json` — ES-module package, single dependency `mqtt`, npm scripts.
- `mqtt-qos/mosquitto.conf` — broker config: listener 1883, anonymous, persistence on.
- `mqtt-qos/docker-compose.mqtt.yml` — Mosquitto service wired to the config.
- `mqtt-qos/common.js` — shared helpers (config, connect, logger, packet logging, summary).
- `mqtt-qos/qos0/publish.js`, `mqtt-qos/qos0/subscribe.js` — QoS 0 pair.
- `mqtt-qos/qos1/publish.js`, `mqtt-qos/qos1/subscribe.js` — QoS 1 pair.
- `mqtt-qos/qos2/publish.js`, `mqtt-qos/qos2/subscribe.js` — QoS 2 pair.
- `mqtt-qos/README.md` — run instructions + per-level demo walkthrough.
- `mqtt-qos/test/integration.test.js` — one automated test proving QoS 0 loss vs QoS 1 redelivery.

Each `subscribe.js` is deliberately self-contained and readable on its own (the grading requirement is "one publish + one subscribe program per QoS level"); `common.js` holds only infrastructure so the QoS-specific behaviour stays visible in each program.

---

## Task 1: Scaffold the `mqtt-qos` package

**Files:**
- Create: `mqtt-qos/package.json`
- Create: `mqtt-qos/.gitignore`

- [ ] **Step 1: Create `mqtt-qos/package.json`**

```json
{
  "name": "mqtt-qos-demo",
  "version": "1.0.0",
  "description": "Standalone MQTT QoS 0/1/2 publish & subscribe demos (teaching)",
  "type": "module",
  "private": true,
  "scripts": {
    "broker:up": "docker compose -f docker-compose.mqtt.yml up",
    "broker:down": "docker compose -f docker-compose.mqtt.yml down",
    "test": "node --test"
  },
  "dependencies": {
    "mqtt": "^5.15.1"
  }
}
```

- [ ] **Step 2: Create `mqtt-qos/.gitignore`**

```
node_modules/
mosquitto/data/
```

- [ ] **Step 3: Install the dependency**

Run: `cd mqtt-qos && npm install`
Expected: `mqtt` installed, `node_modules/` created, exit code 0.

- [ ] **Step 4: Verify mqtt is importable**

Run: `cd mqtt-qos && node -e "import('mqtt').then(m => console.log('mqtt ok', typeof m.default.connect))"`
Expected: prints `mqtt ok function`.

- [ ] **Step 5: Commit**

```bash
git add mqtt-qos/package.json mqtt-qos/.gitignore mqtt-qos/package-lock.json
git commit -m "chore(mqtt-qos): scaffold standalone MQTT QoS demo package"
```

---

## Task 2: Local Mosquitto broker

**Files:**
- Create: `mqtt-qos/mosquitto.conf`
- Create: `mqtt-qos/docker-compose.mqtt.yml`

- [ ] **Step 1: Create `mqtt-qos/mosquitto.conf`**

```
listener 1883
allow_anonymous true
persistence true
persistence_location /mosquitto/data/
```

- [ ] **Step 2: Create `mqtt-qos/docker-compose.mqtt.yml`**

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    container_name: mqtt-qos-broker
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - ./mosquitto/data:/mosquitto/data
    restart: unless-stopped
```

- [ ] **Step 3: Start the broker**

Run: `cd mqtt-qos && docker compose -f docker-compose.mqtt.yml up -d`
Expected: container `mqtt-qos-broker` starts, exit code 0.

- [ ] **Step 4: Verify the broker is listening**

Run: `docker logs mqtt-qos-broker 2>&1 | grep -i "listen socket on port 1883"`
Expected: a line like `Opening ipv4 listen socket on port 1883.`

- [ ] **Step 5: Commit**

```bash
git add mqtt-qos/mosquitto.conf mqtt-qos/docker-compose.mqtt.yml
git commit -m "chore(mqtt-qos): add local Mosquitto broker with persistence"
```

Leave the broker running — later tasks need it.

---

## Task 3: Shared helpers (`common.js`)

**Files:**
- Create: `mqtt-qos/common.js`
- Test: `mqtt-qos/test/common.test.js`

`common.js` exports pure/infrastructure helpers. The only unit-testable piece is `SeqTracker` (gap/duplicate detection); connection/logging are exercised by the integration test in Task 7.

- [ ] **Step 1: Write the failing test for `SeqTracker`**

Create `mqtt-qos/test/common.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeqTracker } from '../common.js';

test('SeqTracker counts received, detects gaps and duplicates', () => {
  const t = new SeqTracker();
  t.record(1);
  t.record(2);
  t.record(2);   // duplicate
  t.record(4);   // gap: 3 missing
  const s = t.summary();
  assert.equal(s.received, 4);
  assert.equal(s.unique, 3);
  assert.equal(s.duplicates, 1);
  assert.deepEqual(s.missing, [3]);
  assert.equal(s.highestSeq, 4);
});

test('SeqTracker with no messages is empty', () => {
  const s = new SeqTracker().summary();
  assert.equal(s.received, 0);
  assert.equal(s.unique, 0);
  assert.equal(s.duplicates, 0);
  assert.deepEqual(s.missing, []);
  assert.equal(s.highestSeq, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mqtt-qos && node --test test/common.test.js`
Expected: FAIL — `Cannot find module '../common.js'` (or `SeqTracker is not exported`).

- [ ] **Step 3: Implement `common.js`**

Create `mqtt-qos/common.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mqtt-qos && node --test test/common.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mqtt-qos/common.js mqtt-qos/test/common.test.js
git commit -m "feat(mqtt-qos): add shared helpers (SeqTracker, logging, handshake)"
```

---

## Task 4: QoS 0 publish & subscribe

**Files:**
- Create: `mqtt-qos/qos0/publish.js`
- Create: `mqtt-qos/qos0/subscribe.js`

- [ ] **Step 1: Create `mqtt-qos/qos0/publish.js`**

```js
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
```

- [ ] **Step 2: Create `mqtt-qos/qos0/subscribe.js`**

```js
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
  const { seq } = JSON.parse(payload.toString());
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
```

- [ ] **Step 3: Smoke-test the pair (broker must be running)**

Run:
```bash
cd mqtt-qos
( node qos0/subscribe.js & echo $! > /tmp/sub0.pid; sleep 1; \
  node qos0/publish.js 3 200; sleep 1; kill -INT $(cat /tmp/sub0.pid) )
```
Expected: subscriber logs `recv seq=1..3` with `qos=0`, then a SUMMARY showing `received (incl. dups): 3`, `missing seq (lost): none`. Publisher logs the PUBLISH handshake lines (`--> PUBLISH`) with no PUBACK.

- [ ] **Step 4: Commit**

```bash
git add mqtt-qos/qos0/publish.js mqtt-qos/qos0/subscribe.js
git commit -m "feat(mqtt-qos): add QoS 0 publish & subscribe"
```

---

## Task 5: QoS 1 publish & subscribe

**Files:**
- Create: `mqtt-qos/qos1/publish.js`
- Create: `mqtt-qos/qos1/subscribe.js`

- [ ] **Step 1: Create `mqtt-qos/qos1/publish.js`**

```js
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
```

- [ ] **Step 2: Create `mqtt-qos/qos1/subscribe.js`**

```js
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
```

- [ ] **Step 3: Smoke-test the pair (broker running)**

Run:
```bash
cd mqtt-qos
( node qos1/subscribe.js & echo $! > /tmp/sub1.pid; sleep 1; \
  node qos1/publish.js 3 200; sleep 1; kill -INT $(cat /tmp/sub1.pid) )
```
Expected: subscriber logs `recv seq=1..3` with `qos=1`, PUBACK handshake visible (`<-- PUBLISH`, `--> PUBACK`), SUMMARY shows `received: 3`, `duplicates: 0`, `missing: none`.

- [ ] **Step 4: Commit**

```bash
git add mqtt-qos/qos1/publish.js mqtt-qos/qos1/subscribe.js
git commit -m "feat(mqtt-qos): add QoS 1 publish & subscribe with duplicate-forcing mode"
```

---

## Task 6: QoS 2 publish & subscribe

**Files:**
- Create: `mqtt-qos/qos2/publish.js`
- Create: `mqtt-qos/qos2/subscribe.js`

- [ ] **Step 1: Create `mqtt-qos/qos2/publish.js`**

```js
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
```

- [ ] **Step 2: Create `mqtt-qos/qos2/subscribe.js`**

```js
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
```

- [ ] **Step 3: Smoke-test the pair (broker running)**

Run:
```bash
cd mqtt-qos
( node qos2/subscribe.js & echo $! > /tmp/sub2.pid; sleep 1; \
  node qos2/publish.js 3 200; sleep 1; kill -INT $(cat /tmp/sub2.pid) )
```
Expected: subscriber logs `recv seq=1..3` with `qos=2`, full 4-way handshake visible (`<-- PUBLISH`, `--> PUBREC`, `<-- PUBREL`, `--> PUBCOMP`), SUMMARY shows `received: 3`, `duplicates: 0`, `missing: none`.

- [ ] **Step 4: Commit**

```bash
git add mqtt-qos/qos2/publish.js mqtt-qos/qos2/subscribe.js
git commit -m "feat(mqtt-qos): add QoS 2 publish & subscribe with exactly-once demo"
```

---

## Task 7: Automated integration test (QoS 0 loss vs QoS 1 redelivery)

**Files:**
- Create: `mqtt-qos/test/integration.test.js`

This test proves the headline effect programmatically: with a persistent session and the subscriber offline, a QoS 0 message is lost while a QoS 1 message is redelivered. It requires the broker on `mqtt://localhost:1883` (or `MQTT_URL`).

- [ ] **Step 1: Write the test**

Create `mqtt-qos/test/integration.test.js`:

```js
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
```

- [ ] **Step 2: Run the test (broker must be running)**

Run: `cd mqtt-qos && node --test test/integration.test.js`
Expected: PASS — both tests pass (QoS 0 lost, QoS 1 redelivered).

- [ ] **Step 3: Commit**

```bash
git add mqtt-qos/test/integration.test.js
git commit -m "test(mqtt-qos): integration test for QoS0 loss vs QoS1 redelivery"
```

---

## Task 8: README with demo walkthrough

**Files:**
- Create: `mqtt-qos/README.md`

- [ ] **Step 1: Create `mqtt-qos/README.md`**

````markdown
# MQTT QoS Demonstration

Standalone Node.js programs showing the effect of each MQTT Quality-of-Service
level. Per level there is one **publish** and one **subscribe** program:

```
qos0/  publish.js  subscribe.js   # at most once  — messages can be LOST
qos1/  publish.js  subscribe.js   # at least once — messages can be DUPLICATED
qos2/  publish.js  subscribe.js   # exactly once  — no loss, no duplicates
```

## Prerequisites

```bash
cd mqtt-qos
npm install
npm run broker:up        # starts Eclipse Mosquitto on localhost:1883
```

Broker URL is overridable: `MQTT_URL=mqtt://host:1883 node qos1/subscribe.js`.

## What each level demonstrates

| Level | Handshake | Subscriber session | Offline behaviour |
|-------|-----------|--------------------|-------------------|
| QoS 0 | PUBLISH | persistent | offline messages **lost** |
| QoS 1 | PUBLISH → PUBACK | persistent | offline messages **redelivered**, duplicates possible |
| QoS 2 | PUBLISH → PUBREC → PUBREL → PUBCOMP | persistent | offline messages **redelivered exactly once** |

Every program logs the control packets (`--> PUBLISH`, `<-- PUBACK`, …) so the
handshake difference between levels is visible. Subscribers print a **summary**
on Ctrl-C: received count, duplicates, and missing (lost) sequence numbers.

## Demo A — QoS 0 loses offline messages

```bash
node qos0/subscribe.js        # terminal 1: subscribe, then Ctrl-C to go offline
node qos0/publish.js 5 500    # terminal 2: publish 5 msgs while sub is offline
node qos0/subscribe.js        # terminal 1: reconnect
```
The reconnected subscriber receives **nothing** from the offline window; its
summary reports the missing sequence numbers. (The persistent session is kept,
but QoS 0 messages are never queued.)

## Demo B — QoS 1 redelivers, and can duplicate

```bash
node qos1/subscribe.js        # terminal 1, then Ctrl-C
node qos1/publish.js 5 500    # terminal 2, while offline
node qos1/subscribe.js        # terminal 1: reconnect -> the 5 msgs arrive
```
To **force a duplicate**, run the subscriber in kill-before-ack mode. It receives
one message, drops the TCP socket before sending PUBACK, so the broker redelivers:

```bash
node qos1/publish.js 1 0                 # publish one message
node qos1/subscribe.js --kill-before-ack # receives it, dies before PUBACK
node qos1/subscribe.js                   # reconnect -> same message, dup=true
```
The second run logs `dup=true`; run it in normal mode afterwards and the summary
counts the duplicate.

## Demo C — QoS 2 is exactly once

```bash
node qos2/subscribe.js        # terminal 1, then Ctrl-C
node qos2/publish.js 5 500    # terminal 2, while offline
node qos2/subscribe.js        # terminal 1: reconnect -> the 5 msgs arrive
```
Even if the subscriber is killed mid-handshake, the message is **not** delivered
twice — the broker redelivers the PUBLISH but the client dedupes it by message id:

```bash
node qos2/publish.js 1 0
node qos2/subscribe.js --kill-mid-handshake
node qos2/subscribe.js        # reconnect -> exactly one delivery, no duplicate
```

## Automated test

```bash
npm test                      # proves QoS0 loss vs QoS1 redelivery (broker required)
```

## Cleanup

```bash
npm run broker:down
```
````

- [ ] **Step 2: Verify the README commands match the code**

Run: `cd mqtt-qos && grep -R "kill-before-ack" qos1/subscribe.js && grep -R "kill-mid-handshake" qos2/subscribe.js`
Expected: both flags found (README instructions match the actual flags).

- [ ] **Step 3: Commit**

```bash
git add mqtt-qos/README.md
git commit -m "docs(mqtt-qos): add README with per-QoS demo walkthrough"
```

---

## Task 9: Final end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd mqtt-qos && node --test`
Expected: all tests pass (common.test.js + integration.test.js), exit code 0.

- [ ] **Step 2: Manually verify each handshake once**

Run Demo A, B, and C from the README. Confirm:
- QoS 0 subscriber summary shows missing sequence numbers after an offline window.
- QoS 1 duplicate run logs `dup=true` and the summary counts a duplicate.
- QoS 2 kill-mid-handshake rerun delivers exactly once (no duplicate).
- Handshake logs differ per level (0: PUBLISH only; 1: +PUBACK; 2: +PUBREC/PUBREL/PUBCOMP).

- [ ] **Step 3: Tear down the broker**

Run: `cd mqtt-qos && npm run broker:down`
Expected: `mqtt-qos-broker` container removed.

- [ ] **Step 4: Confirm clean git state**

Run: `git status`
Expected: working tree clean, all mqtt-qos files committed.
```
