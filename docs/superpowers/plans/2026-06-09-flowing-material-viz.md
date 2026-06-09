# Flowing Material Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render discrete material parts as glowing dots flowing between stations of the PlantSim line, with visible pile-up against full buffers.

**Architecture:** All client-side in `src/public/app.js`. Detect transfer events by diffing cumulative counters across SSE frames, drive a `requestAnimationFrame` particle engine, render each particle as a pooled SVG `<circle>` on an overlay layer with a shared SVG blur filter for glow.

**Tech Stack:** Vanilla ES modules, SVG, `requestAnimationFrame`, CSS variables — no new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-06-09-flowing-material-viz-design.md`

---

## Prerequisites

This project has **no automated test framework**. Each task ends with a manual visual verification step in a running dev server. Start the dev server once and keep it running across tasks:

```bash
cd /home/clemi/mci/machine_sim
npm run dev
# Then open http://localhost:3000 in a browser. The server uses
# node --watch, so changes to src/ reload automatically (refresh the
# browser tab to pick up frontend changes).
```

If port 3000 is in use, kill the previous server first.

---

## Task 1: Add particle layer scaffold and remove old source pulse

**Files:**
- Modify: `src/public/app.js` (add SVG `<defs>` glow filter + `<g id="particle-layer">` insertion inside `buildPipeline`; remove `srcPulse` element creation in `drawSource` and the pulse-trigger block in `updatePipeline`).

- [ ] **Step 1: Locate the relevant blocks in `src/public/app.js`**

You will need to edit three locations:
- Inside `buildPipeline()` — currently builds connectors, then scrap path, then stations. We insert defs + particle layer between the scrap path and `drawSource()`.
- Inside `drawSource()` — remove the `srcPulse` circle creation (the comment is `// Emit pulse ring (animated when part is emitted)`).
- Inside `updatePipeline()` — remove the `if (src.lastEmitted && srcPulse) { … }` block that animates the pulse.

- [ ] **Step 2: Insert `<defs>` and particle layer into `buildPipeline`**

In `src/public/app.js`, find the `buildPipeline()` function. Immediately after the scrap path block (`svg.appendChild(scrapPath);` and the two scrap labels that follow), and before the comment `// ── Source ──…`, insert:

```js
  // ── Particle overlay (sits above connectors, below stations) ─────────────
  const defs = el('defs');
  const glow = el('filter', {
    id: 'part-glow',
    x: '-50%', y: '-50%', width: '200%', height: '200%',
  });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: '2.2' }));
  defs.appendChild(glow);
  svg.appendChild(defs);

  const particleLayer = el('g', {
    id: 'particle-layer',
    filter: 'url(#part-glow)',
  });
  svg.appendChild(particleLayer);
```

- [ ] **Step 3: Remove the old `srcPulse` element from `drawSource`**

In `drawSource()`, delete the block:

```js
  // Emit pulse ring (animated when part is emitted)
  g.appendChild(el('circle', { id: 'src-pulse', cx: x + SRC_W, cy: MAIN_Y, r: 0, fill: 'none',
    stroke: '#818cf8', 'stroke-width': 2, opacity: 0 }));
```

- [ ] **Step 4: Remove the pulse-trigger block from `updatePipeline`**

In `updatePipeline()`, delete the block that begins `// Emit pulse animation` and ends with the closing `}` of `if (src.lastEmitted && srcPulse) { … }`. Also delete the `const srcPulse = document.getElementById('src-pulse');` line at the top of `updatePipeline()`.

- [ ] **Step 5: Manual verify — nothing visually regresses**

Refresh `http://localhost:3000`. Expected:
- Pipeline still renders normally.
- Source no longer flashes the small ring on each emit (that's intentional; we replace it next).
- No console errors.

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js
git commit -m "scaffold particle overlay layer in pipeline SVG

Adds <defs>/feGaussianBlur glow filter and an empty
<g id=\"particle-layer\"> between the connectors and the stations.
Removes the now-superseded srcPulse ring."
```

---

## Task 2: Cache connector geometry and add transfer detector

**Files:**
- Modify: `src/public/app.js` (add a `CONNECTORS` definition, helpers to resolve a point along each connector, and a `detectTransfers(prev, next)` function). Hook it into the SSE message handler for now with `console.debug` so we can confirm detection before rendering anything.

- [ ] **Step 1: Add the connector-geometry module at top of `src/public/app.js`**

Insert below the `LAYOUT` constant block, before `STATE_DESCRIPTION`:

```js
// ── Connector geometry (resolved at buildPipeline time) ───────────────────
// For each pipe along which particles can travel: how to compute the
// (x, y) coordinate of a particle at parametric position t in [0, 1].
// Also: the buffer (if any) whose fullness causes particles to jam here.

const CONNECTORS = [
  { id: 'conn-src-b0',  destBufferId: 'BUF0' },
  { id: 'conn-b0-m1',   destBufferId: null   },  // dest is machine; never jams
  { id: 'conn-m1-b1',   destBufferId: 'BUF1' },
  { id: 'conn-b1-m2',   destBufferId: null   },
  { id: 'conn-m2-b2',   destBufferId: 'BUF2' },
  { id: 'conn-b2-m3',   destBufferId: null   },
  { id: 'conn-m3-b3',   destBufferId: 'BUF3' },
  { id: 'conn-b3-m4',   destBufferId: null   },
  { id: 'conn-m4-sink', destBufferId: null   },  // sink unbounded
  { id: 'conn-m2-scrap',destBufferId: null   },  // scrap unbounded
];

// Filled by cacheConnectorGeometry(); { connectorId -> (t) => {x, y} }
const connectorPointAt = {};
// Filled by cacheConnectorGeometry(); { connectorId -> totalLength (px) }
const connectorLength = {};

function cacheConnectorGeometry() {
  for (const { id } of CONNECTORS) {
    const node = document.getElementById(id);
    if (!node) continue;

    if (node.tagName === 'line') {
      const x1 = parseFloat(node.getAttribute('x1'));
      const y1 = parseFloat(node.getAttribute('y1'));
      const x2 = parseFloat(node.getAttribute('x2'));
      const y2 = parseFloat(node.getAttribute('y2'));
      const len = Math.hypot(x2 - x1, y2 - y1);
      connectorLength[id] = len;
      connectorPointAt[id] = (t) => ({
        x: x1 + (x2 - x1) * t,
        y: y1 + (y2 - y1) * t,
      });
    } else {
      // SVG <path> — used for the scrap branch (L-shaped)
      const len = node.getTotalLength();
      connectorLength[id] = len;
      connectorPointAt[id] = (t) => {
        const p = node.getPointAtLength(len * t);
        return { x: p.x, y: p.y };
      };
    }
  }
}
```

- [ ] **Step 2: Call `cacheConnectorGeometry()` from `buildPipeline`**

In `buildPipeline()`, after the line `svg.appendChild(particleLayer);` (added in Task 1), add:

```js
  cacheConnectorGeometry();
```

(Connectors are appended before this point, so they exist in the DOM.)

- [ ] **Step 3: Add the transfer detector**

Insert below `cacheConnectorGeometry`:

```js
// ── Transfer detection (pure: prev/next state -> particle spawn events) ──
// Each event: { connectorId, kind: 'good'|'scrap', count }

function detectTransfers(prev, next) {
  if (!prev || !next) return [];
  const events = [];

  const bufBy = (state, id) =>
    state.buffers.find(b => b.id === id) ?? { totalPartsOut: 0, load: 0, capacity: 0 };
  const machBy = (state, id) =>
    state.machines.find(m => m.id === id) ?? { partsProcessed: 0 };

  // Source -> BUF0
  const srcDelta = next.source.totalGenerated - prev.source.totalGenerated;
  if (srcDelta > 0) events.push({ connectorId: 'conn-src-b0', kind: 'good', count: srcDelta });

  // Buffer pulls (cumulative totalPartsOut)
  const bufPulls = [
    ['BUF0', 'conn-b0-m1'],
    ['BUF1', 'conn-b1-m2'],
    ['BUF2', 'conn-b2-m3'],
    ['BUF3', 'conn-b3-m4'],
  ];
  for (const [bufId, connId] of bufPulls) {
    const d = bufBy(next, bufId).totalPartsOut - bufBy(prev, bufId).totalPartsOut;
    if (d > 0) events.push({ connectorId: connId, kind: 'good', count: d });
  }

  // Machine outputs
  const m1d = machBy(next, 'M1').partsProcessed - machBy(prev, 'M1').partsProcessed;
  if (m1d > 0) events.push({ connectorId: 'conn-m1-b1', kind: 'good', count: m1d });

  const m2d  = machBy(next, 'M2').partsProcessed - machBy(prev, 'M2').partsProcessed;
  const m2sd = next.scrap.partsReceived - prev.scrap.partsReceived;
  if (m2sd > 0)            events.push({ connectorId: 'conn-m2-scrap', kind: 'scrap', count: m2sd });
  const m2good = Math.max(0, m2d - m2sd);
  if (m2good > 0)          events.push({ connectorId: 'conn-m2-b2', kind: 'good', count: m2good });

  const m3d = machBy(next, 'M3').partsProcessed - machBy(prev, 'M3').partsProcessed;
  if (m3d > 0) events.push({ connectorId: 'conn-m3-b3', kind: 'good', count: m3d });

  const m4d = machBy(next, 'M4').partsProcessed - machBy(prev, 'M4').partsProcessed;
  if (m4d > 0) events.push({ connectorId: 'conn-m4-sink', kind: 'good', count: m4d });

  return events;
}
```

- [ ] **Step 4: Wire detection into the SSE handler (log only)**

Find the SSE handler near the bottom of `app.js` (inside `connectSSE()` → `es.addEventListener('message', e => { … })`).

After the line `lastMetrics = metrics;` and before `if (!slidersBuilt && state.machines) {`, insert:

```js
    // Particle flow: detect transfers between consecutive state snapshots
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) {
      console.debug('[transfers]', transfers);
    }
    prevStateForDiff = state;
```

At module scope (near the existing `let lastState = null;` block), add:

```js
let prevStateForDiff = null;
```

- [ ] **Step 5: Manual verify — events appear in the console**

Refresh the page, open the browser devtools console, and start the sim. Expected:
- A stream of `[transfers]` log entries appears, e.g. `[{connectorId:"conn-src-b0", kind:"good", count:1}, …]`.
- Setting M2 reject rate > 0 in the control panel produces `kind:"scrap"` entries on `conn-m2-scrap`.
- Pausing the sim stops the log.

If detections are missing or doubled, inspect the relevant state fields with `lastState` in the console.

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js
git commit -m "detect part transfers by diffing SSE state snapshots

Adds connector geometry cache and a pure detectTransfers() that
emits per-pipe spawn events from cumulative state counters. Logged
to console for verification; renderer comes next."
```

---

## Task 3: Particle pool, engine loop, and basic renderer

**Files:**
- Modify: `src/public/app.js` (particle struct, pool, spawn function, requestAnimationFrame loop, position update).
- Modify: `src/public/style.css` (add `.particle` and `.particle.scrap` rules).

This task establishes flowing dots without trail, jam, or pause handling — those land in later tasks.

- [ ] **Step 1: Add particle CSS in `src/public/style.css`**

Append at the end of the file:

```css
/* ── Flowing material particles ─────────────────────────────────────────── */

.particle {
  fill: var(--accent);
  pointer-events: none;
}
.particle.scrap { fill: var(--blocked); }
.particle.hidden { visibility: hidden; }
```

- [ ] **Step 2: Add the particle engine block in `src/public/app.js`**

Insert below `detectTransfers` and above `// ── SVG helpers ─` (or wherever fits the existing section ordering — the file currently flows: constants → helpers → builders → updaters → controls. Add a new section right above the SSE block, after `updateMetricsDashboard`/`drawSparkline`):

```js
// ── Particle engine ───────────────────────────────────────────────────────
// In-flight particles travelling between stations. Driven by rAF.

const PARTICLE_DURATION_MS = 400;   // travel time at 1× sim speed
const PARTICLE_RADIUS      = 3.5;
const POOL_GROWTH          = 16;

let particlePool = [];      // { node: <circle>, inUse: boolean }
let particles    = [];      // active Particle objects
let lastFrameTs  = 0;
let rafHandle    = null;

function ensureParticleNodes(n) {
  while (particlePool.length < n) {
    const c = el('circle', { r: PARTICLE_RADIUS, class: 'particle hidden' });
    document.getElementById('particle-layer').appendChild(c);
    particlePool.push({ node: c, inUse: false });
  }
}

function acquireParticleNode() {
  for (const slot of particlePool) {
    if (!slot.inUse) { slot.inUse = true; slot.node.classList.remove('hidden'); return slot; }
  }
  ensureParticleNodes(particlePool.length + POOL_GROWTH);
  return acquireParticleNode();
}

function releaseParticleNode(slot) {
  slot.inUse = false;
  slot.node.classList.add('hidden');
}

function spawnParticle({ connectorId, kind, delayMs = 0 }) {
  if (!connectorPointAt[connectorId]) return;
  const slot = acquireParticleNode();
  if (kind === 'scrap') slot.node.classList.add('scrap');
  else                  slot.node.classList.remove('scrap');

  const now = performance.now();
  particles.push({
    slot,
    connectorId,
    kind,
    startedAt: now + delayMs,
    duration:  PARTICLE_DURATION_MS,
  });
}

function spawnFromEvents(events) {
  for (const ev of events) {
    for (let i = 0; i < ev.count; i++) {
      spawnParticle({
        connectorId: ev.connectorId,
        kind: ev.kind,
        delayMs: i * 80,    // stagger when multiple in one frame
      });
    }
  }
}

function advanceParticles(now) {
  if (particles.length === 0) return;

  // Iterate backwards so we can splice retired particles cheaply.
  for (let i = particles.length - 1; i >= 0; i--) {
    const p   = particles[i];
    const raw = (now - p.startedAt) / p.duration;
    const t   = Math.max(0, Math.min(1, raw));

    const fn = connectorPointAt[p.connectorId];
    if (!fn) { releaseParticleNode(p.slot); particles.splice(i, 1); continue; }

    const pt = fn(t);
    p.slot.node.setAttribute('cx', pt.x.toFixed(2));
    p.slot.node.setAttribute('cy', pt.y.toFixed(2));

    if (raw >= 1) { releaseParticleNode(p.slot); particles.splice(i, 1); }
  }
}

function particleLoop(ts) {
  lastFrameTs = ts;
  advanceParticles(ts);
  rafHandle = requestAnimationFrame(particleLoop);
}

function startParticleLoop() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(particleLoop);
}

function resetParticles() {
  for (const p of particles) releaseParticleNode(p.slot);
  particles = [];
}
```

- [ ] **Step 3: Pre-seed the particle pool and start the loop in `buildPipeline`**

In `buildPipeline()`, after `cacheConnectorGeometry();`, add:

```js
  particlePool = [];   // particle <circle>s lived inside #particle-layer
  particles    = [];
  ensureParticleNodes(32);
  startParticleLoop();
```

(The first line resets the pool array because `svg.innerHTML = ''` at the start of `buildPipeline` has already removed the old DOM nodes.)

- [ ] **Step 4: Replace the console.debug with real spawning in the SSE handler**

Replace the block added in Task 2:

```js
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) {
      console.debug('[transfers]', transfers);
    }
    prevStateForDiff = state;
```

with:

```js
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) spawnFromEvents(transfers);
    prevStateForDiff = state;
```

- [ ] **Step 5: Manual verify — dots flow between stations**

Refresh the page and start the sim. Expected:
- Blue glowing dots travel from Source → BUF0 → M1 → BUF1 → M2 → BUF2 → M3 → BUF3 → M4 → SINK.
- Throughput visible to the eye: more dots when sim is faster.
- M2-to-scrap branch parts are NOT yet styled red — they appear blue too. That's expected (we fix in Task 4 by verifying styling and the path renders correctly via `getPointAtLength`).
- No console errors.

If dots appear at wrong locations, suspect `cacheConnectorGeometry`. If dots don't appear, check the particle layer has been appended (`document.getElementById('particle-layer')` in console).

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js src/public/style.css
git commit -m "add particle engine with pooled SVG circles

Particles spawn from detected transfer events, travel along their
connector via a cached point-at-t function, and retire when they
reach the destination. Driven by a single requestAnimationFrame
loop. No jam-up or tail yet."
```

---

## Task 4: Verify scrap-branch routing and styling

**Files:**
- Modify: `src/public/app.js` (no code change expected; this task is a verification + a fix if scrap-path geometry doesn't resolve cleanly).
- Modify: `src/public/style.css` (no change expected).

The detector already emits `kind: 'scrap'` for `conn-m2-scrap`. The renderer already applies the `.scrap` class. The path uses `getPointAtLength` because the connector is an SVG `<path>` (not `<line>`). This task verifies that combo end-to-end.

- [ ] **Step 1: Manual verify — red dots peel off down the scrap branch**

In the running app, set M2 reject rate to ~50% via the control panel slider. Expected:
- Some dots leaving M2 turn red and travel down then right along the L-shaped scrap path to the SCRAP box.
- Other dots leaving M2 stay blue and continue rightward to BUF2.
- The ratio roughly matches the slider.

If red dots appear in the wrong place (e.g. travelling along the wrong segment), inspect `connectorPointAt['conn-m2-scrap'](0.5)` in the console — it should return a point on the vertical segment below M2 (around x = M2 centre, y ≈ 185).

- [ ] **Step 2: If scrap dots are misplaced, debug**

The scrap path is defined in `buildPipeline()` as an SVG `<path>` with `d = "M cx bottom L cx scrapY L scrapEndX scrapY"`. `getPointAtLength` will linearly traverse that. If the rendered position is wrong, verify:
- The `<path>` is in the DOM before `cacheConnectorGeometry()` runs (it is — confirm by reading `buildPipeline` order).
- `node.tagName === 'path'` correctly falls through to the `else` branch in `cacheConnectorGeometry`.

(Most likely no change is needed — this step exists to catch a regression early.)

- [ ] **Step 3: Commit only if a change was needed**

If no code change was required, skip this commit step entirely and move to Task 5. If a fix was applied:

```bash
git add src/public/app.js
git commit -m "fix scrap-branch particle geometry"
```

---

## Task 5: Jam-up behavior against full buffers

**Files:**
- Modify: `src/public/app.js` (extend the engine to stop particles near the destination when its buffer is full).

- [ ] **Step 1: Cache the latest state for the rAF loop**

The particle engine needs to know whether each connector's destination buffer is full. Add a module-scope reference set by the SSE handler.

Near the top of the particle-engine block (right above `let particlePool = [];`), add:

```js
let particleSimState = null;   // latest server snapshot, used for jam checks
```

In the SSE handler, immediately after `prevStateForDiff = state;`, add:

```js
    particleSimState = state;
```

- [ ] **Step 2: Add a helper to look up buffer fullness by connector**

In the particle engine section, below `releaseParticleNode`:

```js
function isDestBufferFull(connectorId) {
  if (!particleSimState) return false;
  const conn = CONNECTORS.find(c => c.id === connectorId);
  if (!conn || !conn.destBufferId) return false;
  const buf = particleSimState.buffers.find(b => b.id === conn.destBufferId);
  if (!buf) return false;
  return buf.load >= buf.capacity;
}
```

- [ ] **Step 3: Extend `advanceParticles` to pile up jammed particles**

Replace the body of `advanceParticles(now)` with:

```js
function advanceParticles(now) {
  if (particles.length === 0) return;

  // Group jammed particles per-connector so we can assign stack indexes.
  const jamStackCounters = {};   // connectorId -> next stackIndex

  // Walk in spawn order (oldest first) so older particles sit deeper
  // into the jam (closer to the buffer wall).
  for (let i = 0; i < particles.length; i++) {
    const p   = particles[i];
    const raw = (now - p.startedAt) / p.duration;
    let   t   = Math.max(0, Math.min(1, raw));

    const blocked = isDestBufferFull(p.connectorId);
    if (blocked && t > 0.85) {
      const idx = jamStackCounters[p.connectorId] ?? 0;
      jamStackCounters[p.connectorId] = idx + 1;
      // Older particles get smaller idx -> sit closer to the buffer.
      t = Math.max(0.55, 0.85 - idx * 0.06);
      p.jammed = true;
    } else {
      p.jammed = false;
    }

    const fn = connectorPointAt[p.connectorId];
    if (!fn) continue;
    const pt = fn(t);
    p.slot.node.setAttribute('cx', pt.x.toFixed(2));
    p.slot.node.setAttribute('cy', pt.y.toFixed(2));
  }

  // Retire un-jammed particles that finished traveling.
  for (let i = particles.length - 1; i >= 0; i--) {
    const p   = particles[i];
    const raw = (performance.now() - p.startedAt) / p.duration;
    if (!p.jammed && raw >= 1) {
      releaseParticleNode(p.slot);
      particles.splice(i, 1);
    }
  }
}
```

When the buffer drains, `blocked` becomes false on the next frame and the particle's natural `t` resumes (since `startedAt` was never modified). It will land within ~one frame.

- [ ] **Step 4: Manual verify — particles pile up at full buffers**

In the running sim:
1. Set BUF1 capacity to 1 (lowest possible) via the slider.
2. Set M1 cycle time to 1 and M2 cycle time to 10 — M2 is now much slower than M1.
3. Watch the M1→BUF1 pipe.

Expected:
- BUF1 fills to 1/1.
- M1 finishes parts faster than M2 can consume them.
- Blue dots pile up against BUF1: you see ~5 stacked dots near the end of the pipe.
- The pipe's connector turns red (existing blocked-style behavior).
- When M2 catches up and BUF1 drains, the queue releases and dots flow again.

- [ ] **Step 5: Commit**

```bash
git add src/public/app.js
git commit -m "pile up particles against full downstream buffers

When a connector's destination buffer is at capacity, in-flight
particles freeze at t ≤ 0.85 with FIFO stack indexes so the user
sees a visible queue against the buffer wall."
```

---

## Task 6: Add fading trailing dot

**Files:**
- Modify: `src/public/app.js` (each particle now also drives a second, larger, fainter circle slightly behind it).
- Modify: `src/public/style.css` (add `.particle-tail` rule).

- [ ] **Step 1: Add tail CSS**

Append to `src/public/style.css`:

```css
.particle-tail {
  fill: var(--accent);
  opacity: 0.22;
  pointer-events: none;
}
.particle-tail.scrap { fill: var(--blocked); }
.particle-tail.hidden { visibility: hidden; }
```

- [ ] **Step 2: Extend the pool to also produce tail nodes**

In `src/public/app.js`, replace `ensureParticleNodes` with:

```js
function ensureParticleNodes(n) {
  const layer = document.getElementById('particle-layer');
  while (particlePool.length < n) {
    const tail = el('circle', { r: PARTICLE_RADIUS * 1.6, class: 'particle-tail hidden' });
    const head = el('circle', { r: PARTICLE_RADIUS,         class: 'particle hidden' });
    layer.appendChild(tail);
    layer.appendChild(head);   // head drawn over tail
    particlePool.push({ node: head, tail, inUse: false });
  }
}
```

- [ ] **Step 3: Show/hide and color the tail alongside the head**

Replace `acquireParticleNode` with:

```js
function acquireParticleNode() {
  for (const slot of particlePool) {
    if (!slot.inUse) {
      slot.inUse = true;
      slot.node.classList.remove('hidden');
      slot.tail.classList.remove('hidden');
      return slot;
    }
  }
  ensureParticleNodes(particlePool.length + POOL_GROWTH);
  return acquireParticleNode();
}
```

Replace `releaseParticleNode` with:

```js
function releaseParticleNode(slot) {
  slot.inUse = false;
  slot.node.classList.add('hidden');
  slot.tail.classList.add('hidden');
}
```

In `spawnParticle`, after the existing `if (kind === 'scrap') …else…` block for `slot.node`, mirror the same toggle for `slot.tail`:

```js
  if (kind === 'scrap') slot.tail.classList.add('scrap');
  else                  slot.tail.classList.remove('scrap');
```

- [ ] **Step 4: Position the tail behind the head in `advanceParticles`**

Inside `advanceParticles`, after the line `p.slot.node.setAttribute('cy', pt.y.toFixed(2));` (in the first loop), add:

```js
    const tailT = Math.max(0, t - 0.08);
    const tailPt = fn(tailT);
    p.slot.tail.setAttribute('cx', tailPt.x.toFixed(2));
    p.slot.tail.setAttribute('cy', tailPt.y.toFixed(2));
```

- [ ] **Step 5: Manual verify — visible tails**

Refresh the page. Expected:
- Every moving dot has a slightly larger, fainter dot trailing behind it. The tail follows along the same path (including the L-bend on the scrap branch).
- At very low sim speed the tail is barely visible (small spatial offset); at higher speeds it's clearly a tail.
- Jammed dots (Task 5 scenario) also have their tails parked behind them in the queue.

- [ ] **Step 6: Commit**

```bash
git add src/public/app.js src/public/style.css
git commit -m "add fading trailing dot behind each particle"
```

---

## Task 7: Pause/resume freeze + clean reset

**Files:**
- Modify: `src/public/app.js` (freeze particles while sim is paused; clear particle state on reset).

The rAF loop runs continuously, so when the sim is paused we need to shift each particle's `startedAt` forward by the paused-frame delta — otherwise particles "catch up" the moment sim resumes.

- [ ] **Step 1: Track pause state and shift `startedAt` while paused**

At the top of the particle-engine block, add:

```js
let particleSimPaused = false;
```

Replace `particleLoop` with:

```js
function particleLoop(ts) {
  const dt = lastFrameTs > 0 ? ts - lastFrameTs : 0;
  lastFrameTs = ts;

  if (particleSimPaused && dt > 0) {
    // Freeze: roll every active particle's clock forward by dt.
    for (const p of particles) p.startedAt += dt;
  }

  advanceParticles(ts);
  rafHandle = requestAnimationFrame(particleLoop);
}
```

In the SSE handler, immediately after `particleSimState = state;`, add:

```js
    particleSimPaused = !state.running;
```

- [ ] **Step 2: Clear particle state in `applyReset`**

In `applyReset()`, after `buildPipeline();` (which already recreates the DOM and pool), add:

```js
  prevStateForDiff = newState;   // baseline; no spurious deltas next frame
  resetParticles();
```

(`resetParticles()` releases pool slots; `buildPipeline()` already rebuilds the layer DOM, so any orphan visuals are gone.)

- [ ] **Step 3: Manual verify — pause, play, reset all behave**

1. **Pause:** Click Pause while dots are mid-pipe. Expected: every dot freezes in place (including jammed queues).
2. **Play:** Click Play. Expected: dots resume from where they froze and continue to their destinations.
3. **Reset:** Click Reset. Expected: all in-flight dots disappear; counters reset; on next play, dots flow from the source again with no leftover state.
4. **Reset to defaults:** Same expectation, plus the sliders snap back to defaults.

- [ ] **Step 4: Commit**

```bash
git add src/public/app.js
git commit -m "freeze particles while sim paused and clear on reset"
```

---

## Task 8: Final manual QA pass

**Files:** none modified.

Run through the full verification plan from the design doc with a clean slate.

- [ ] **Step 1: Hard refresh (Cmd/Ctrl+Shift+R) and play through the checklist**

From `docs/superpowers/specs/2026-06-09-flowing-material-viz-design.md` § "Testing":

1. Start sim → blue dots travel along every connector, including each BUF→machine micro-segment.
2. Set M2 reject rate ~50% → red dots peel off down the scrap branch in roughly the expected ratio.
3. Lower BUF1 capacity to 1 and raise M1 throughput → dots pile up against BUF1's inlet; pipe turns red; queue releases when M2 catches up.
4. Switch to 8× speed → particle streams stay coherent (staggered, not popping); no console errors.
5. Pause/play → particles freeze and resume.
6. Reset and Reset-to-defaults → particles cleared cleanly.

- [ ] **Step 2: Check the browser console for warnings/errors during the full QA run**

Expected: no errors, no `[transfers]` debug log (that was removed in Task 3), no SVG attribute warnings.

- [ ] **Step 3: Confirm the feature in the README spirit**

Open `README.md`. The "Source File Guide" section already mentions `app.js` as the SVG renderer + SSE client. The new particle engine fits under that role — no README change required.

- [ ] **Step 4: Final commit (only if any QA fixes were applied)**

```bash
git status
# If clean, no commit needed. If any small fix was applied during QA:
git add -p
git commit -m "QA fixes for flowing material viz"
```
