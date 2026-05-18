/**
 * server.js
 * Fastify HTTP server — glues together the simulation engine, metrics, and
 * the static frontend. Entry point for the application.
 *
 * Routes:
 *   GET  /              → serves index.html (the visual frontend)
 *   GET  /api/state     → current simulation state (JSON)
 *   GET  /api/metrics   → calculateMetrics() output (JSON, for frontend polling)
 *   GET  /api/events    → SSE stream, pushes state+metrics every 500 ms
 *   POST /api/control   → play/pause/reset/param updates
 *   GET  /metrics       → Prometheus scrape endpoint (text/plain)
 */

import Fastify        from 'fastify';
import fastifyStatic  from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { SimulationEngine } from './simulation/engine.js';
import { DEFAULT_CONFIG }   from './simulation/config.js';
import { calculateMetrics } from './metrics/collector.js';
import { updateMetrics, register } from './metrics/prometheus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT ?? '3000', 10);

// ── Bootstrap simulation ───────────────────────────────────────────────────

const engine = new SimulationEngine(DEFAULT_CONFIG);
engine.play(); // auto-start so students see motion immediately on page load

// ── Create Fastify instance ────────────────────────────────────────────────

const app = Fastify({ logger: false });

// Serve files from src/public/ as static assets
app.register(fastifyStatic, {
  root:   join(__dirname, 'public'),
  prefix: '/',
});

// ── SSE helpers ───────────────────────────────────────────────────────────

// Active SSE connections — we push to all of them every 500 ms
const sseClients = new Set();

setInterval(() => {
  if (sseClients.size === 0) return;
  const state   = engine.getState();
  const metrics = calculateMetrics(state);
  const payload = JSON.stringify({ state, metrics });
  const line    = `data: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.raw.write(line); } catch (_) { sseClients.delete(res); }
  }
}, 500);

// ── Routes ─────────────────────────────────────────────────────────────────

// SSE stream
app.get('/api/events', (req, res) => {
  res.raw.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if behind a proxy
  });
  res.raw.write(':\n\n'); // initial keep-alive comment
  sseClients.add(res);

  req.raw.on('close', () => sseClients.delete(res));
});

// Current state (JSON)
app.get('/api/state', async () => engine.getState());

// Computed metrics (JSON)
app.get('/api/metrics', async () => {
  const state = engine.getState();
  return calculateMetrics(state);
});

// Control endpoint
app.post('/api/control', async (req, res) => {
  const { action, params = {} } = req.body ?? {};

  switch (action) {
    case 'play':           engine.play();           break;
    case 'pause':          engine.pause();          break;
    case 'reset':          engine.reset();          break;
    case 'resetToDefaults': engine.resetToDefaults(); break;
    default:
      // No recognised action — may still have params to update
  }

  if (Object.keys(params).length > 0) {
    engine.updateConfig(params);
  }

  return { ok: true, tick: engine.tick };
});

// Prometheus scrape endpoint
app.get('/metrics', async (req, res) => {
  const state = engine.getState();
  updateMetrics(state);
  res.header('Content-Type', register.contentType);
  return register.metrics();
});

// ── Start server ───────────────────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`PlantSim PoC running at http://0.0.0.0:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
