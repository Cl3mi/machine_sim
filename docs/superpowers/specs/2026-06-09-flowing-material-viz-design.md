# Flowing Material Visualization — Design

**Date:** 2026-06-09
**Scope:** Frontend only (`src/public/app.js`, `src/public/style.css`)
**Goal:** Show discrete parts flowing along the pipes between stations of the
PlantSim production line, with visible jam-up when a downstream buffer is full.

---

## Motivation

The current pipeline view draws stations and static connectors. The reader
can see counts and machine states change but cannot *see* parts moving. For
a discrete-event teaching tool, watching parts traverse the line is the
clearest possible illustration of throughput, blocking, and scrap.

## What "flow" means visually

- Each part transfer between two stations is rendered as a small glowing dot
  ("particle") that travels along the corresponding connector over ~400 ms.
- Good parts are blue (`--accent`, `#818cf8`); parts dropped onto the M2
  scrap branch are red (`--blocked`, `#ef4444`).
- A short trailing dot (larger radius, lower opacity) follows each particle
  to give a "tail" effect.
- When a destination buffer is full, in-flight particles pile up at the
  inlet instead of disappearing — a visible jam.
- The existing `srcPulse` ring is removed; the particle stream out of the
  source replaces it.

## Architecture

All work is client-side in `src/public/app.js`. No server, engine, or wire
format change. The SSE stream already delivers everything we need: cumulative
counters that we diff between consecutive frames.

Three new units:

### 1. Transfer detector

`detectTransfers(prevState, newState)` — pure function. Returns an array of
spawn events:

```
{ connectorId: string,
  kind: 'good' | 'scrap',
  count: number }   // how many particles to spawn on this pipe this frame
```

It diffs the cumulative counters listed below. If `count > 1` (multiple
transfers in one 500 ms SSE window, common at higher sim speeds) the spawner
staggers them by ~80 ms so they appear as a stream rather than a single blob.

### 2. Particle engine

Owns `particles: Particle[]`. Driven by `requestAnimationFrame`. Each
particle:

```
{ id, connectorId, kind, startedAt, duration,
  pathLength,        // cached from connector geometry
  pathFn,            // (t) -> {x, y} ; see "Geometry"
  stackIndex,        // assigned at jam time
  retired }          // true once it lands or is reset
```

Per frame:
1. Read current sim state for downstream-full check (cached from latest SSE).
2. Compute `t = (now - startedAt) / duration`, clamp to `[0, 1]`.
3. If the destination buffer is full and `t > 0.85`, freeze the particle at
   `t = 0.85 - stackIndex * 0.06` (about 5 dots fit visibly along the pipe
   tail). `stackIndex` is the particle's order in the queue at this
   connector among others already jammed.
4. When `t >= 1` and not jammed, mark `retired = true` and hide the SVG node.
5. Position the SVG circle (and its trail sibling) from `pathFn(t)`.

When the simulation is paused (`state.running === false`), the rAF loop
still runs but `startedAt` is shifted forward by the elapsed delta so
particles freeze in place. Resume continues seamlessly.

### 3. Particle renderer

A new `<g id="particle-layer">` is appended once during `buildPipeline()`,
*after* the connector lines and station boxes are drawn — it sits on top
of the connectors but is appended before machine groups so machine
borders stay clickable. (Verified order: connectors → scrap path →
stations. Particle layer inserts immediately after the scrap path.)

A small SVG `<defs>` block adds the glow filter:

```xml
<filter id="part-glow" x="-50%" y="-50%" width="200%" height="200%">
  <feGaussianBlur stdDeviation="2.2"/>
</filter>
```

The particle layer uses `filter="url(#part-glow)"` so every child circle
glows without per-element cost.

A pool of pre-created `<circle>` nodes (initial pool size 32, grows on
demand) is reused across particle lifetimes — no createElement/remove
churn.

## Detection rules (per-pipe)

The engine state shape (verified in `src/simulation/engine.js`) gives us
these cumulative fields:

- `source.totalGenerated`
- `machines[i].partsProcessed`
- `buffers[i].totalPartsOut`     (number of pulls *out* of the buffer)
- `sink.partsReceived`
- `scrap.partsReceived`

| Connector       | Trigger (delta = new − prev)             | Kind  |
|-----------------|------------------------------------------|-------|
| `conn-src-b0`   | `source.totalGenerated`                  | good  |
| `conn-b0-m1`    | `buffers.BUF0.totalPartsOut`             | good  |
| `conn-m1-b1`    | `M1.partsProcessed`                      | good  |
| `conn-b1-m2`    | `buffers.BUF1.totalPartsOut`             | good  |
| `conn-m2-b2`    | `M2.partsProcessed − scrap.partsReceived delta` (clamped ≥ 0) | good |
| `conn-m2-scrap` | `scrap.partsReceived`                    | scrap |
| `conn-b2-m3`    | `buffers.BUF2.totalPartsOut`             | good  |
| `conn-m3-b3`    | `M3.partsProcessed`                      | good  |
| `conn-b3-m4`    | `buffers.BUF3.totalPartsOut`             | good  |
| `conn-m4-sink`  | `M4.partsProcessed`                      | good  |

The buffer-pull detector is used because it is exact and doesn't rely on
state-transition heuristics. M2 good/scrap split is computed by subtracting
the scrap delta from M2's processed delta.

## Geometry

Connectors are straight horizontal `<line>`s except the M2→scrap path,
which is an SVG `<path>` with two segments. Two `pathFn` implementations:

- **Line:** `(t) => ({ x: lerp(x1, x2, t), y: lerp(y1, y2, t) })`
- **Path (scrap branch):** `(t) => path.getPointAtLength(pathLength * t)`,
  with `pathLength = path.getTotalLength()` cached at pipeline-build time.

Both are resolved once per particle when it spawns and stored on the
particle so the per-frame work is constant-time.

## Jam behavior

A downstream buffer is "full" iff `buf.load >= buf.capacity` for that
connector's destination buffer. The check happens once per rAF frame
(cheap; 4 buffers). The `conn-m4-sink` and `conn-m2-scrap` pipes have
no destination buffer (sink and scrap are unbounded) and therefore
never jam.

When full:
- New particles are still allowed to *spawn* (the upstream machine
  produced the part) and *travel*, but they cannot finish — they stop at
  `t ≤ 0.85`.
- Particles waiting on the same connector are assigned increasing
  `stackIndex` (0, 1, 2, …) and freeze at progressively smaller `t`,
  creating a visible queue against the buffer wall.
- When the buffer drains (load drops below capacity), the queue releases
  in FIFO order — each particle resumes by re-setting its `startedAt` so
  its remaining travel takes the remaining proportional duration.

This is consistent with the engine semantics where a blocked machine
keeps the finished part in `currentPart` until the downstream buffer has
room.

## Styling

Added to `style.css`:

```css
.particle {
  fill: var(--accent);
  pointer-events: none;
}
.particle.scrap { fill: var(--blocked); }
.particle-tail {
  fill: var(--accent);
  opacity: 0.25;
  pointer-events: none;
}
.particle-tail.scrap { fill: var(--blocked); }
```

The glow filter on the `<g>` parent handles the bloom for every child
node uniformly.

## Reset semantics

`buildPipeline()` already clears `svg.innerHTML`. The redraw will:
- Recreate the `<defs>` glow filter and `particle-layer` group.
- Drop the `particles` array entirely.
- Re-cache connector geometry (line endpoints; scrap path length).

`applyReset()` and `applyReset('resetToDefaults')` go through
`buildPipeline()` already, so no new wiring needed.

`prevStateForDiff` is reset to the post-reset state so the next SSE
frame's delta starts from zero and we don't spuriously emit particles
for cumulative counters that the new server-side state might still show.

## Speed / performance

Expected concurrent particles:
- 1× speed, healthy line: ~6–10 particles.
- 8× speed (`speed=8`): up to ~40 in unusual bursts (still trivial for SVG).
- Jammed line: bounded by the visible stack of 5 per connector × 10
  connectors = 50 max.

Pool starts at 32 circles, grows in chunks of 16 if exceeded.
`requestAnimationFrame` is paused (cancelled and re-scheduled) when the
sim is paused for a battery saving.

## Out of scope

- No particle-level color coding for individual part IDs (would clutter).
- No "ghost" particles inside buffers — existing slot-square rendering
  already shows buffer occupancy.
- No animation along the buffer→machine micro-segments below a certain
  zoom level (we *do* animate them, but no separate visual treatment).
- No tooltip on particles.
- Server-side per-tick event log: deliberately not added; client-side
  diffing is sufficient and avoids a wire-format change.

## Files touched

- `src/public/app.js` — new `detectTransfers`, particle engine, particle
  renderer, `<defs>` setup; removal of the old `srcPulse` block in
  `drawSource` and `updatePipeline`; integration with `buildPipeline`
  and the SSE handler.
- `src/public/style.css` — `.particle`, `.particle-tail` rules.

No new files; no server, engine, or HTML changes.

## Testing

This project has no automated UI tests. Manual verification plan:

1. `docker compose up --build` → open http://localhost:3000.
2. **Steady state:** start sim → confirm blue dots travel between every
   pair of stations, including across the BUF→machine micro-segments.
3. **Scrap branch:** set M2 reject rate to ~50% → confirm a visible mix
   of red dots peeling off down the scrap branch and blue dots
   continuing to BUF2.
4. **Jam:** lower BUF1 capacity to 1 and raise M1 cycle time to 1 →
   confirm dots pile up against the BUF1 inlet, pipe turns red, and
   the queue releases when M2 catches up.
5. **Speed:** at 8× speed, confirm streams remain coherent (staggered,
   not popping).
6. **Pause/play:** particles freeze on pause and resume on play.
7. **Reset:** "Reset" and "Reset to defaults" both clear all in-flight
   particles cleanly.
