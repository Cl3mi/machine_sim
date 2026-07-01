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
