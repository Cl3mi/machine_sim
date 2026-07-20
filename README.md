# PlantSim PoC — Multi-Machine Production Line Simulation

A self-contained, browser-based teaching tool for university students learning
**Tecnomatix PlantSim** concepts and Industry 4.0 connectivity protocols. The
core is a production line — Source → 4 Machines → Sink — running as a
discrete-event tick simulation in Node.js, visualised in real time via SVG +
Server-Sent Events.

Around that core, the project demonstrates a full industrial-connectivity
stack:

| Capability | What it shows | Where |
|---|---|---|
| **Machine simulation** | Discrete-event line, live SVG view, play/pause/reset/speed, presets, tunable buffers/cycle times/reject rate, CSV/JSON export | `src/simulation/`, `src/public/` |
| **OPC UA server** | A live plant exposed as a standards-based OPC UA address space, browsable from UAExpert or any OPC UA client | `src/opcua/` |
| **Prometheus + Grafana** | Real-time metrics (throughput, lead time, utilization, bottlenecks) scraped and dashboarded | `src/metrics/`, `grafana/`, `prometheus.yml` |
| **MQTT QoS 0/1/2 demo** | Standalone publish/subscribe programs illustrating message loss, duplication, and exactly-once delivery per QoS level | `mqtt-qos/` |

---

## Quick Start

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

```bash
# From the repository root
docker compose up --build
```

| Service | URL |
|---|---|
| Simulation UI | http://localhost:3000 |
| OPC UA (TCP) | `opc.tcp://localhost:4840/UA/PlantSim` |
| OPC UA (WebSocket bridge) | `ws://localhost:3000/opcua` |

Open http://localhost:3000 — the production line starts running immediately;
use the control panel to play/pause, change speed, tune buffers/cycle
times/reject rate, load a preset, or export tick history as CSV/JSON.

### Optional: Prometheus + Grafana dashboard

```bash
docker compose -f docker-compose.yml -f docker-compose.grafana.yml up --build
```

| Service     | URL                        | Credentials    |
|-------------|----------------------------|----------------|
| App (main)  | http://localhost:3000      | —              |
| Grafana     | http://localhost:3001      | admin/plantsim |
| Prometheus  | http://localhost:9090      | —              |

Grafana comes pre-provisioned with a **PlantSim Production Line** dashboard
(`grafana/provisioning/dashboards/plantsim.json`) showing throughput, average
lead time, parts-in-system, scrap count, per-machine utilization and
blocked/starved time, and buffer fill ratios — all sourced from the app's
`/metrics` endpoint (`src/metrics/prometheus.js`) via Prometheus
(`prometheus.yml`).

### Optional: MQTT QoS 0/1/2 demo

A separate, standalone Node.js mini-project under `mqtt-qos/` (its own
`package.json`, not wired into the main app) that demonstrates the practical
difference between MQTT's three Quality-of-Service levels using a local
Mosquitto broker:

```bash
cd mqtt-qos
npm install
npm run broker:up        # starts Eclipse Mosquitto on localhost:1883
node qos0/subscribe.js   # terminal 1
node qos0/publish.js 5 500   # terminal 2 — see QoS 0 lose messages sent while offline
npm run broker:down
```

See `mqtt-qos/README.md` for the full walkthrough (QoS 0 loss, QoS 1
duplicates, QoS 2 exactly-once, plus the automated test suite).

### Running without Docker

```bash
npm install
npm start            # node src/server.js — serves on :3000, OPC UA on :4840
npm run dev           # same, with --watch
npm test              # node --test — runs the src/ and test/ suites
```

Useful environment variables (all optional, sensible defaults apply):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `OPCUA_TCP_PORT` | `4840` | Raw OPC UA TCP endpoint port |
| `OPCUA_ENDPOINT_URL` | `ws://localhost:<PORT>/opcua` | Endpoint advertised to OPC UA clients (override when running behind a reverse proxy, e.g. `opc.wss://your-host/opcua`) |

---

## OPC UA Server

The simulation exposes an OPC UA server alongside the HTTP / SSE / Prometheus
endpoints, reachable both as raw TCP and via a WebSocket bridge (for OPC UA
clients that only support WebSocket transport, e.g. browser-based tooling).
The OPC UA server is backed by a **dedicated plant engine** — a separate
`SimulationEngine` from the per-browser-session engines, so that UAExpert and
the demo client always see the same canonical plant.

| What         | Where                                         |
|--------------|-----------------------------------------------|
| TCP endpoint | `opc.tcp://localhost:4840/UA/PlantSim`        |
| WebSocket bridge | `ws://localhost:3000/opcua` (`src/opcua/bridge.js`) |
| Namespace    | `urn:mci:plantsim` (`ns=1`)                   |
| Security     | `SecurityPolicy.None`, anonymous (lab only)   |
| Node tree    | `docs/opcua/nodes.json`                       |

### Quick demo

```bash
# 1. Start the stack
docker compose up --build

# 2. (option A) Connect with UAExpert
#    → Browse Objects → Line, drag Tick / M1.State / BUF1.Level into a Data Access view

# 2. (option B) Run the included Node.js client
node tools/opcua-client-demo.js
```

### Available methods on `Line.Methods`

| Method         | Effect                                              |
|----------------|-----------------------------------------------------|
| `Play()`       | `engine.play()`                                     |
| `Pause()`      | `engine.pause()`                                    |
| `Reset()`      | `engine.reset()` (preserves user-tuned config)      |
| `SetSpeed(x)`  | `engine.setSpeed(x)` — `x` must be a positive number |

### Production hardening (out of scope here)

For non-lab use, enable `Basic256Sha256` + certificate-based auth in
`src/opcua/server.js` (`securityPolicies`, `securityModes`, `userManager`),
and either bind the port to localhost only or terminate at a TLS reverse proxy.

---

## MQTT QoS Demonstration

`mqtt-qos/` is a self-contained teaching module (independent of the
simulation app) with one publish/subscribe pair per QoS level:

```
mqtt-qos/
  qos0/  publish.js  subscribe.js   # at most once  — messages can be LOST
  qos1/  publish.js  subscribe.js   # at least once — messages can be DUPLICATED
  qos2/  publish.js  subscribe.js   # exactly once  — no loss, no duplicates
```

Each program logs the underlying MQTT control packets (`--> PUBLISH`,
`<-- PUBACK`, …) and subscribers print a summary on Ctrl-C (received count,
duplicates, missing sequence numbers), making the wire-level difference
between QoS levels directly observable. See `mqtt-qos/README.md` for
step-by-step demo scripts (offline redelivery, forced duplicates, forced
mid-handshake kills) and the automated test suite.

---

## Prometheus & Grafana Monitoring

- `src/metrics/collector.js` — pure function: simulation state snapshot →
  metrics object (throughput, avg lead time, utilization, bottleneck flag,
  buffer fill ratios). No side effects, directly unit-testable.
- `src/metrics/prometheus.js` — wraps `collector.js` into `prom-client`
  gauges, exposed at `GET /metrics`.
- `prometheus.yml` — scrapes `localhost:3000/metrics` every 5s.
- `grafana/provisioning/` — datasource + dashboard auto-provisioned on
  Grafana startup; no manual dashboard import needed.

Bring the overlay up with `docker compose -f docker-compose.yml -f docker-compose.grafana.yml up --build` (see Quick Start above).

---

## Source File Guide

| File | Role |
|---|---|
| `src/server.js` | Fastify HTTP server; SSE stream; all HTTP routes; boots the OPC UA server + WS bridge |
| `src/simulation/engine.js` | Tick loop, state machine, blocking/starvation logic |
| `src/simulation/entities.js` | Plain data classes: Part, Machine, Buffer, Source, Sink |
| `src/simulation/config.js` | Default parameters (cycle times, capacities, reject rate) |
| `src/simulation/presets.js` | Curated scenario presets loadable from the UI |
| `src/opcua/server.js` | OPC UA server bootstrap, address space wiring, `Line.Methods` |
| `src/opcua/nodeset.js` | Declarative OPC UA node tree definition |
| `src/opcua/bridge.js` | WebSocket ↔ TCP bridge so browser/limited clients can reach the OPC UA server |
| `src/metrics/collector.js` | **Pure function** — state snapshot → metrics object |
| `src/metrics/prometheus.js` | Wraps collector.js into prom-client gauges |
| `src/public/index.html` | Page shell and layout |
| `src/public/style.css` | Dark-theme CSS |
| `src/public/app.js` | SVG pipeline renderer, SSE client, control panel |
| `mqtt-qos/` | Standalone MQTT QoS 0/1/2 teaching demo (own `package.json`) |
| `tools/opcua-client-demo.js` | Example Node.js OPC UA client against the running server |
| `tools/generate-nodes-json.js` | Regenerates `docs/opcua/nodes.json` from `src/opcua/nodeset.js` |

---

## PlantSim Concept → Code Mapping

| PlantSim Concept | Implementation Location |
|---|---|
| SimEvent / `Simulation.run()` | `engine.js` — `_tick()` + `_scheduleNext()` |
| Object attributes / methods | `entities.js` — class fields |
| Store / Queue object | `Buffer` class in `entities.js`; push/pull logic in `engine.js` |
| BackPressure (cannot-enter) | `engine.js` → `_tryPushDownstream()` → `machine.state = BLOCKED` |
| NoPart (cannot-start) | `engine.js` Step 3 — `machine.state = STARVED` |
| Statistics object / Auslastung | `collector.js` → `utilization = ticksProcessing / totalTicks` |
| Bottleneck Analyzer | `collector.js` → `bottleneck` flag (highest `blockedTime` ratio) |
| Durchlaufzeit (DLZ) | `collector.js` → `avgLeadTime` |
| Produktionsrate | `collector.js` → `throughput` |
| EventController | `engine.js` — `play()`, `pause()`, `reset()`, `setSpeed()` |
| Object library (drag & drop) | `config.js` — add a machine/buffer entry and re-run |

---

## How to Modify the Simulation

### Add a machine

1. Add an entry to `machines` array in `src/simulation/config.js`:
   ```js
   { id: 'M5', name: 'Veredelung', cycleTime: 3 }
   ```
2. Add a matching buffer *before* it in the `buffers` array:
   ```js
   { id: 'BUF4', capacity: 2 }
   ```
3. In `src/public/app.js`, add entries to `LAYOUT` and call `drawMachine()`/`drawBuffer()` in `buildPipeline()`.

### Change a buffer capacity at runtime

Use the **Buffer Capacities** sliders in the control panel — changes take effect immediately.

### Change the reject rate at runtime

Use the **Reject rate** slider under **Quality Gate (M2)**.

### Change cycle times at runtime

Use the **Machine Cycle Times** sliders in the control panel.

### Make material stock infinite

Set **Material stock** slider to its maximum, or set `materialStock: -1` in `config.js`
(the engine treats `-1` as infinite supply; `0` means depleted).

---

## Architecture Notes

- **No build step** — the frontend is plain HTML/CSS/ES-module JS, readable without any tooling.
- **Deterministic** — given the same random seed, the simulation produces the same output (the reject gate uses `Math.random()`; swap it for a seeded PRNG for full reproducibility).
- **Tick direction** — machines are advanced from the *end* of the line backwards each tick, preventing a part from jumping through multiple stations in one tick (the "domino effect").
- **Metrics are pure** — `collector.js` has no side effects and can be unit-tested by passing any state snapshot.
- **MQTT demo is intentionally decoupled** — `mqtt-qos/` has its own `package.json` and Mosquitto broker so it can be run/taught independently of the simulation app.
