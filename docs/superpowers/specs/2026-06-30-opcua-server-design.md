# Design: OPC UA Server for PlantSim PoC

**Date:** 2026-06-30
**Status:** Draft — awaiting user review
**Scope:** Add an OPC UA server to the existing PlantSim simulation so the
production line's state can be browsed and controlled with a standard
OPC UA client (UAExpert) and a small Node.js demo client.

---

## 1. Goal

The lecturer's brief requires three deliverables:

1. A system-architecture diagram (C4 / UML) showing components and dependencies.
2. A simulation implementation that communicates with an OPC UA server
   (examples named: umati, MS IoT Edge OPC UA PLC).
3. OPC UA node definitions (JSON or XML).

The PlantSim PoC already simulates a Source → 4 Machines → Sink line in
Node.js with a Fastify HTTP server, SSE-streamed browser UI, and a
Prometheus / Grafana stack. This design extends that codebase by making
the simulation itself act as an OPC UA **server** — playing the same role
as umati or the MS IoT Edge PLC simulator: a virtual machine that exposes
its internal state over OPC UA. A standard OPC UA client (UAExpert) and a
small Node.js client script demonstrate end-to-end communication.

## 2. Non-goals

- Production-grade OPC UA security (certificates, user auth). The server
  runs with `SecurityPolicy.None` + anonymous tokens, documented as a
  lab-only choice.
- Compliance with the umati / OPC 40001 Machinery companion specification.
  A flat custom namespace is used for pedagogical clarity.
- Migration of the existing SSE / Prometheus paths. OPC UA is added
  alongside them, not in place of them.
- A custom GUI for OPC UA clients. UAExpert covers the visual demo;
  the bundled Node.js script covers the code demo.

## 3. System architecture

Container view (C4 Container diagram):

```
┌─────────────────────────────────────────────────────────────────────┐
│  Docker container: plantsim                                          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Node.js process (Fastify)                                      │ │
│  │                                                                  │ │
│  │   ┌─────────────┐    tick    ┌──────────────┐                   │ │
│  │   │   engine    │ ─────────► │  state store │                   │ │
│  │   │ (tick loop) │            │ (in-memory)  │                   │ │
│  │   └─────┬───────┘            └──────┬───────┘                   │ │
│  │         │                            │ sync                      │ │
│  │         │ play/pause/reset           ▼                           │ │
│  │   ┌─────┴──────────────────────────────────────────┐ ┌────────┐ │ │
│  │   │  controls (HTTP + OPC UA Methods)              │ │ OPC UA │ │ │
│  │   └────────────────────────────────────────────────┘ │ server │ │ │
│  │                                                       │ (4840) │ │ │
│  │   ┌─────────────┐  ┌────────────────────────┐        └────┬───┘ │ │
│  │   │ SSE /stream │  │ /metrics (Prometheus)  │             │     │ │
│  │   └──────┬──────┘  └───────────┬────────────┘             │     │ │
│  └──────────┼─────────────────────┼──────────────────────────┼─────┘ │
│      :3000 ▼                :3000 ▼                    :4840 ▼       │
└─────────────────────────────────────────────────────────────────────┘
          │                       │                       │
     ┌────▼─────┐          ┌──────▼─────┐          ┌──────▼──────┐
     │ Browser  │          │ Prometheus │          │  UAExpert   │
     │   UI     │          │ + Grafana  │          │  + Node.js  │
     │  (SVG)   │          │            │          │   client    │
     └──────────┘          └────────────┘          └─────────────┘
```

Component view (UML component diagram, Node modules):

```
   ┌──────────────────────┐
   │ src/server.js        │ — Fastify boot, routes, lifecycle
   └──────┬───────────────┘
          │ uses
          ▼
   ┌──────────────────────┐        ┌─────────────────────────┐
   │ src/simulation/      │ ◄───── │ src/opcua/server.js     │
   │   engine.js          │ reads  │   builds address space, │
   │   entities.js        │        │   syncs nodes per tick, │
   │   config.js          │        │   handles methods       │
   └──────────────────────┘        └─────────┬───────────────┘
          ▲                                  │ uses
          │ calls                            ▼
   ┌──────┴───────────────┐        ┌─────────────────────────┐
   │ src/controls.js      │ ◄───── │ src/opcua/nodeset.js    │
   │ play/pause/reset/    │        │ declarative node tree,  │
   │   setSpeed wrappers  │        │ JSON export             │
   └──────────────────────┘        └─────────────────────────┘
```

Both diagrams are committed as PlantUML sources under
`docs/architecture/` (`c4-container.puml`, `components.puml`) with
rendered PNGs alongside.

## 4. OPC UA address space

**Namespace URI:** `urn:mci:plantsim` (`ns=1`). PascalCase identifiers.

```
Objects/
└── Line  (FolderType)
    ├── Throughput            Double   parts/min
    ├── AvgLeadTime           Double   ticks
    ├── Tick                  UInt32   monotonic counter
    ├── State                 String   "RUNNING" | "PAUSED"
    ├── Speed                 Double   tick multiplier
    │
    ├── Methods/
    │   ├── Play()                     → controls.play()
    │   ├── Pause()                    → controls.pause()
    │   ├── Reset()                    → controls.reset()
    │   └── SetSpeed(Double)           → controls.setSpeed(x)
    │
    ├── Source
    │   ├── TotalGenerated    UInt32
    │   ├── MaterialStock     UInt32   0 = infinite
    │   └── Interval          UInt32   ticks
    │
    ├── Sink
    │   ├── PartsReceived     UInt32
    │   └── ScrapReceived     UInt32
    │
    ├── Machines/  (FolderType)
    │   ├── M1, M2, M3, M4   each Object with:
    │   │   ├── Name              String (immutable)
    │   │   ├── CycleTime         UInt32
    │   │   ├── State             String  IDLE|PROCESSING|BLOCKED|STARVED
    │   │   ├── PartsProcessed    UInt32
    │   │   ├── Utilization       Double  0–1
    │   │   ├── TicksProcessing   UInt32
    │   │   ├── TicksBlocked      UInt32
    │   │   ├── TicksStarved      UInt32
    │   │   ├── TicksIdle         UInt32
    │   │   └── RejectRate        Double  0–1
    │
    └── Buffers/  (FolderType)
        ├── BUF0, BUF1, BUF2, BUF3  each Object with:
        │   ├── Capacity      UInt32
        │   ├── Level         UInt32
        │   ├── Fill          Double  Level/Capacity
        │   └── AvgWaitTicks  Double
```

**Conventions:**

- All variables are **read-only**. The only client-driven writes go through
  the explicit Methods on `Line` (`Play`, `Pause`, `Reset`, `SetSpeed`).
- Machine `State` is published as a `String` matching the existing
  `MachineState` enum in `entities.js`. An OPC UA `EnumeratedType` would be
  more correct but adds NodeSet2 XML complexity that does not serve the
  teaching goal.
- Variable values are sourced directly from existing engine fields. No new
  metrics are computed for OPC UA.

**Node-definitions deliverable:** `docs/opcua/nodes.json` — a declarative
tree (browseName, dataType, accessLevel, description, parent) generated
from `src/opcua/nodeset.js` so the document and the running server cannot
drift apart.

## 5. Data flow & lifecycle

### Startup

1. Fastify binds `:3000` (existing).
2. Engine is constructed from `config.js` (existing).
3. `opcua/server.js` builds the address space from `nodeset.js`, binds
   `:4840`, registers method handlers. Build failures (e.g. duplicate
   `nodeId`) cause fail-fast process exit before HTTP traffic is accepted.
4. Engine starts ticking.

### Per-tick cycle

```
engine._tick()
   │ mutates state
   ▼
collector.snapshot(state)                ← existing
   ├─► SSE clients                       ← existing
   ├─► prom-client gauges                ← existing
   └─► opcua.sync(snapshot)              ← NEW
         │ for each Variant: node.setValueFromSource(...)
         ▼
       node-opcua delivers DataChangeNotifications to subscribed clients
```

`opcua.sync()` is synchronous and idempotent. `node-opcua`'s internal
change detection means subscribers receive only deltas.

### Client-driven control flow

```
UAExpert calls Line.Play()
   ▼
method handler in opcua/server.js
   ▼
controls.play()           ← shared with HTTP route
   ▼
engine.play()
   ▼
next tick's sync() reflects the new State value
```

Method handlers return `StatusCodes.Good` on success and
`BadInvalidArgument` on bad input (e.g. `SetSpeed(-1)`). They never throw
across the `node-opcua` boundary.

### Shutdown

`SIGINT` / `SIGTERM` → Fastify close → `opcuaServer.shutdown(1000)` →
process exit.

## 6. Error handling

- `opcua.sync()` is wrapped in try/catch that logs and continues. A sync
  failure must not kill the tick loop — the simulation is the primary
  product.
- Port `4840` already bound → log + non-zero exit. No fallback to a random
  port (silent failures break the demo).
- Method handler errors are translated to OPC UA `StatusCode`s, never
  raised as JS exceptions.
- Subscriber disconnects are non-fatal; `node-opcua` cleans up sessions.

## 7. Security (lab scope)

- `SecurityPolicy.None`, `MessageSecurityMode.None`, anonymous user-token.
- Bound to `0.0.0.0` inside the container; in `docker-compose.yml` port
  `4840` is published to the host so a desktop UAExpert can connect.
- README documents this as a deliberate lab choice with a pointer to
  enabling `Basic256Sha256` + certificates for production.

## 8. Testing & demo plan

### Automated

- `src/opcua/server.test.js` — boots the OPC UA server against a stub
  engine state, connects an in-process `node-opcua` client, asserts:
  1. The namespace contains the expected nodes.
  2. A value change in the stub propagates to a MonitoredItem callback
     within one `sync()` call.
  3. `Play()` and `Pause()` methods flip the engine's `running` flag.
- `src/opcua/nodeset.test.js` — snapshot test on
  `docs/opcua/nodes.json` so any node-tree change is reviewed deliberately.

### Manual demo for the lecturer

1. `docker compose up --build`.
2. UAExpert → `opc.tcp://localhost:4840` → browse `Objects/Line` →
   screenshot of the tree.
3. Drag `M1.State`, `BUF1.Level`, `Line.Throughput` into a data-access
   view → screenshot of live updates.
4. Right-click `Line.Pause()` → Call → screenshot showing the SVG UI
   freezing and values stabilising.
5. `node tools/opcua-client-demo.js` → terminal screenshot of subscription
   output. This script is the "Programm-Code" piece for the brief.

## 9. Deliverables mapping

| Brief requirement                              | Artefact in repo                                               |
|------------------------------------------------|----------------------------------------------------------------|
| Systemarchitektur (C4 / UML)                   | `docs/architecture/c4-container.puml`, `components.puml` + PNGs|
| Simulation incl. OPC UA server communication   | `src/opcua/server.js`, `src/opcua/nodeset.js`, `src/controls.js`, existing engine, `tools/opcua-client-demo.js` |
| OPC UA node definitions                        | `docs/opcua/nodes.json` (generated, committed)                 |

## 10. Out-of-scope follow-ups

- Migrating to the OPC 40001 Machinery companion spec for an
  umati-compatible namespace.
- Replacing the Prometheus pipeline with Telegraf's `opcua` input.
- Adding OPC UA security (certs, user tokens).
- Persisting historical samples via OPC UA Historical Access (HA).
