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
To **force a duplicate**, run the subscriber in kill-before-ack mode, then publish
one message:

```bash
node qos1/subscribe.js --kill-before-ack   # terminal 1
node qos1/publish.js 1 0                    # terminal 2
```
The subscriber receives the message (`dup=false`), drops the socket before its
PUBACK, then auto-reconnects; the broker redelivers the un-acked message
(`dup=true`) to the **same** process. Press Ctrl-C — the summary reports
`received (incl. dups): 2` and `duplicates: 1`.

## Demo C — QoS 2 is exactly once

```bash
node qos2/subscribe.js        # terminal 1, then Ctrl-C
node qos2/publish.js 5 500    # terminal 2, while offline
node qos2/subscribe.js        # terminal 1: reconnect -> the 5 msgs arrive
```
Even if the subscriber's socket is destroyed right after it receives a message,
QoS 2 does **not** deliver it twice:

```bash
node qos2/subscribe.js --kill-mid-handshake   # terminal 1
node qos2/publish.js 1 0                       # terminal 2
```
The subscriber receives the message (`dup=false`), drops the socket, then
auto-reconnects and finishes the handshake — but the message is not handed to the
app again. Press Ctrl-C — the summary reports `received (incl. dups): 1` and
`duplicates: 0` (contrast with QoS 1 above, which reports a duplicate).

## Automated test

```bash
npm test                      # proves QoS0 loss vs QoS1 redelivery (broker required)
```

## Cleanup

```bash
npm run broker:down
```
