# PlantSim PoC — Multi-Machine Production Line Simulation

A self-contained, browser-based teaching tool for university students learning
**Tecnomatix PlantSim** concepts. The entire production line — Source → 4 Machines
→ Sink — runs as a discrete-event tick simulation in Node.js, visualised in real
time via SVG + Server-Sent Events.

---

## Quick Start

```bash
# Clone / enter the directory
cd plantsim-poc

# Start the app (builds Docker image, starts container)
docker compose up --build

# Open http://localhost:3000
```

### Optional: Grafana + Prometheus dashboard

```bash
docker compose -f docker-compose.yml -f docker-compose.grafana.yml up --build
```

| Service     | URL                        | Credentials    |
|-------------|----------------------------|----------------|
| App (main)  | http://localhost:3000      | —              |
| Grafana     | http://localhost:3001      | admin/plantsim |
| Prometheus  | http://localhost:9090      | —              |

---

## Source File Guide

| File | Role |
|---|---|
| `src/server.js` | Fastify HTTP server; SSE stream; all HTTP routes |
| `src/simulation/engine.js` | Tick loop, state machine, blocking/starvation logic |
| `src/simulation/entities.js` | Plain data classes: Part, Machine, Buffer, Source, Sink |
| `src/simulation/config.js` | Default parameters (cycle times, capacities, reject rate) |
| `src/metrics/collector.js` | **Pure function** — state snapshot → metrics object |
| `src/metrics/prometheus.js` | Wraps collector.js into prom-client gauges |
| `src/public/index.html` | Page shell and layout |
| `src/public/style.css` | Dark-theme CSS |
| `src/public/app.js` | SVG pipeline renderer, SSE client, control panel |

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
