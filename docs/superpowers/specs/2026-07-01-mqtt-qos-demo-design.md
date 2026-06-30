# MQTT QoS Demonstration — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

## Goal

Erfülle die Lecturer-Anforderung: pro MQTT-QoS-Level (0, 1, 2) je ein **publish**-
und ein **subscribe**-Programm. In den Programmen müssen die **Auswirkungen** des
jeweiligen QoS-Levels erkennbar sein:

- **QoS 0** (at most once): Nachrichtenverlust möglich, keine Bestätigung.
- **QoS 1** (at least once): garantierte Zustellung, aber Duplikate möglich.
- **QoS 2** (exactly once): kein Verlust, keine Duplikate (4-Wege-Handshake).

## Scope decisions

- **Komplett unabhängig** vom PlantSim-Simulationscode. Eigener Ordner, künstliche
  Demo-Nachrichten, kein Bezug zur Engine/OPC-UA-Bridge.
- **Sprache:** Node.js (JavaScript, ES-Module), Library `mqtt` (mqtt.js).
- **Broker:** lokaler Eclipse Mosquitto via Docker, URL per ENV überschreibbar.
- **Sichtbarkeit:** volle Stufe — Paket-Level-Handshake-Logging **plus**
  Verlust-/Duplikat-Erkennung über Sequenznummern, plus End-Summary.

Out of scope: TLS/Auth, Retained Messages, Last Will, Bridging zur Simulation,
Integration in `docker-compose.yml` der Hauptanwendung.

## Directory structure

```
mqtt-qos/
  docker-compose.mqtt.yml      # Eclipse Mosquitto Broker (Port 1883)
  mosquitto.conf               # allow_anonymous true, listener 1883, persistence true
  package.json                 # type:module, dependency: mqtt
  common.js                    # connect(), Zeitstempel-Logger, Paket-Event-Hook, Summary-Helfer
  README.md                    # Schritt-für-Schritt-Demo pro QoS, was zu beobachten ist
  qos0/  publish.js  subscribe.js
  qos1/  publish.js  subscribe.js
  qos2/  publish.js  subscribe.js
```

Ergibt exakt die geforderten **6 Programme** (publish + subscribe pro Level).
`common.js` enthält ausschließlich Infrastruktur (Verbindung, Logging); die
QoS-spezifische Logik (QoS-Wert, Session-Verhalten, Demo-Trick) steht sichtbar in
jedem der 6 Programme.

## Shared mechanics (`common.js` + Konventionen)

- **Sequenznummerierte Nachrichten:** Payload JSON `{ seq, ts }`. Publisher zählt
  `seq = 1,2,3,…`. Subscriber erkennt damit eindeutig **Lücken** (Verlust) und
  **Wiederholungen** (Duplikate).
- **Paket-Event-Hook:** `client.on('packetsend' | 'packetreceive')` wird geloggt,
  sodass der Handshake live sichtbar ist:
  - QoS 0 → nur `PUBLISH`
  - QoS 1 → `PUBLISH → PUBACK`
  - QoS 2 → `PUBLISH → PUBREC → PUBREL → PUBCOMP`
- **Zeitgestempelter Logger** für nachvollziehbare Reihenfolge.
- **Subscriber-Summary** bei Beenden (SIGINT/Ctrl-C): empfangen / erwartet,
  Liste verlorener `seq`, Anzahl Duplikate.
- **Konfiguration:** Broker-URL `MQTT_URL` (Default `mqtt://localhost:1883`),
  Topic je Level fix (`demo/qos0`, `demo/qos1`, `demo/qos2`), Anzahl/Intervall der
  Publisher-Nachrichten per Argument oder Konstante.

## Per-level demonstration

Entscheidender Hebel: **persistent session** beim Subscriber (`clean: false`,
fester `clientId` pro Level). Nur damit puffert der Broker Offline-Nachrichten —
und genau hier trennt sich QoS 0 von QoS 1/2.

| Level | Subscriber-Session | Demo-Szenario | Sichtbarer Effekt |
|---|---|---|---|
| QoS 0 | persistent (`clean:false`) | Subscriber stoppen → Publisher sendet → Subscriber neu starten | Offline-Nachrichten werden **verworfen** → Summary zeigt fehlende `seq` |
| QoS 1 | persistent | gleiches Szenario + `manualAcks`-Trick (PUBACK unterdrücken / Crash vor Ack) | Nachrichten werden **nachgeliefert**, dabei **Duplikate** mit `dup`-Flag → Summary zählt sie |
| QoS 2 | persistent | gleiches Szenario | Nachrichten werden **nachgeliefert, exactly-once** → keine Lücke, kein Duplikat |

### QoS-1-Duplikat-Trick

Zuverlässiges Erzwingen eines Duplikats: Subscriber im `{ manualAcks: true }`-Modus
empfängt eine Nachricht, sendet aber absichtlich **kein** `PUBACK` (bzw. Prozess
wird vor dem Ack beendet). Beim Reconnect liefert der Broker dieselbe Nachricht mit
`dup = 1` erneut aus → Duplikat sichtbar und in der Summary gezählt. Wird im README
als optionaler Schritt dokumentiert.

## Broker setup

- `docker-compose.mqtt.yml`: Service `eclipse-mosquitto`, Port `1883:1883`,
  mountet `mosquitto.conf`. Eigene Compose-Datei, getrennt von der Hauptanwendung.
- `mosquitto.conf`: `listener 1883`, `allow_anonymous true`, **`persistence true`**
  (sonst überlebt die Session keinen Broker-Neustart; QoS 1/2 könnten nicht puffern).
- Start: `docker compose -f mqtt-qos/docker-compose.mqtt.yml up`.

## README contents

- Voraussetzungen + Broker starten.
- Pro Level: genaue Befehlsfolge (Subscriber starten/stoppen, Publisher senden,
  Subscriber neu starten) und **was man in der Ausgabe beobachten soll**.
- Erklärtabelle QoS 0/1/2 mit erwartetem Ergebnis.
- Hinweis auf den QoS-1-`manualAcks`-Trick.

## Testing / verification

Manuelle Verifikation über die README-Szenarien (Lehrkontext, interaktiv):

1. Broker hoch.
2. QoS 0: Lücken in der Summary nach Offline-Phase nachweisbar.
3. QoS 1: Nachlieferung + mind. ein Duplikat (über manualAcks-Trick) nachweisbar.
4. QoS 2: vollständige Nachlieferung ohne Duplikat nachweisbar.
5. Handshake-Logs zeigen je Level die korrekte Paketfolge.
```
