/**
 * collector.js
 * Pure metrics calculation — no side effects, no external state.
 *
 * This module receives a simulation state snapshot (the JSON object returned
 * by engine.getState()) and returns a plain metrics object. You can call it
 * from the Prometheus scrape endpoint, from the REST API, or from unit tests
 * without ever touching the simulation engine itself.
 *
 * PlantSim concept mapping:
 *   - utilization      → Statistics object / "Auslastung"
 *   - bottleneck flag  → Bottleneck Analyzer result
 *   - avgLeadTime      → "Durchlaufzeit" (DLZ)
 *   - throughput       → "Produktionsrate"
 */

// A station whose average machine utilization exceeds this is "busy" — the
// first gate for being the line's constraint. Tunable.
const BOTTLENECK_UTIL_THRESHOLD = 0.6;
// A station blocked more than this fraction of the time is a *victim* of a
// downstream constraint, not the constraint itself — it fails the second gate.
const BLOCKED_MAX = 0.05;
// A station starved at least this fraction of the time is "starved"; also used
// for the source-starved diagnostic and the STARVED_BY_UPSTREAM classification.
const STARVED_MIN = 0.10;
// Confidence-score weights (sum to 1): utilization, un-blockedness, downstream
// starvation, upstream buffer fill.
const W_UTIL   = 0.4;
const W_BLOCK  = 0.2;
const W_STARVE = 0.2;
const W_FILL   = 0.2;
// Keep in sync with engine MAX_MACHINES_PER_STATION — no point suggesting a
// spawn for a station that is already full.
const MAX_MACHINES_PER_STATION = 4;
// Bottleneck detection is suppressed for the first WARMUP_TICKS of a run. The
// utilization window holds too little data early on, so ratios swing wildly and
// the verdict (marker, banner) would flicker. ~3s at the default 10 ticks/s.
const WARMUP_TICKS = 30;

/**
 * calculateMetrics(state) → metrics object
 *
 * @param {object} state  - snapshot from SimulationEngine.getState()
 * @returns {object}      - structured metrics, ready for JSON or Prometheus
 */
export function calculateMetrics(state) {
  const tick     = state.tick || 1; // avoid division by zero at tick 0
  const machines = state.machines  ?? [];
  const buffers  = state.buffers   ?? [];
  const sink     = state.sink      ?? { partsReceived: 0, recentParts: [] };
  const scrap    = state.scrap     ?? { partsReceived: 0 };

  // ── Throughput ─────────────────────────────────────────────────────────────
  // Parts completed per 100 ticks — a normalised rate students can compare
  // across different simulation run lengths.
  const throughput = tick > 0
    ? (sink.partsReceived / tick) * 100
    : 0;

  // ── Average lead time ──────────────────────────────────────────────────────
  // Avg ticks from Source emission to Sink arrival, over recent completed parts.
  let avgLeadTime = 0;
  if (sink.recentParts && sink.recentParts.length > 0) {
    const totalLead = sink.recentParts.reduce(
      (sum, p) => sum + (p.completedAt - p.createdAt), 0
    );
    avgLeadTime = totalLead / sink.recentParts.length;
  }

  // ── Parts currently in the system ─────────────────────────────────────────
  // Sum of parts in all buffers + parts inside machines
  const partsInBuffers  = buffers.reduce((sum, b) => sum + b.load, 0);
  const partsInMachines = machines.filter(m => m.currentPartId !== null).length;
  const partsInSystem   = partsInBuffers + partsInMachines;

  // ── Per-machine metrics ────────────────────────────────────────────────────
  const bufferById = {};
  for (const b of buffers) bufferById[b.id] = b;

  // Utilization and bottleneck detection use recent-window tick counts (winX)
  // so the verdict reflects current flow; we fall back to lifetime counters for
  // snapshots that predate windowing (e.g. unit-test fixtures).
  const winTicks = (m) => ({
    proc:    m.winProcessing ?? m.ticksProcessing,
    blocked: m.winBlocked    ?? m.ticksBlocked,
    starved: m.winStarved    ?? m.ticksStarved,
    idle:    m.winIdle       ?? m.ticksIdle,
  });

  const machineMetrics = machines.map(m => {
    const w = winTicks(m);
    const totalTicks = w.proc + w.blocked + w.starved + w.idle;
    const utilization  = totalTicks > 0 ? w.proc    / totalTicks : 0;
    const blockedRatio = totalTicks > 0 ? w.blocked / totalTicks : 0;
    const starvedRatio = totalTicks > 0 ? w.starved / totalTicks : 0;

    const upstreamBuffer = bufferById[m.inputBufferId] ?? null;
    const avgQueueWait   = upstreamBuffer && upstreamBuffer.totalPartsOut > 0
      ? upstreamBuffer.totalWaitTicks / upstreamBuffer.totalPartsOut
      : 0;

    return {
      id:           m.id,
      stationId:    m.stationId,
      name:         m.name,
      utilization,
      avgQueueWait,
      blockedTime:  m.ticksBlocked,
      starvedTime:  m.ticksStarved,
      blockedRatio,                 // own ratio, 0–1
      starvedRatio,                 // own ratio, 0–1
      currentState: m.state,
      bottleneck:          false,   // filled in by detection below
      flowState:           'BALANCED',
      isPrimaryConstraint: false,
    };
  });

  // ── Bottleneck detection (flow-based: utilization gate + starvation/blocking) ─
  // A station is the *true constraint* when it is busy (high utilization) AND
  // barely blocked — a blocked station is a victim of a downstream constraint.
  // Two confirming flow signals (a starved downstream, a backed-up upstream
  // buffer) raise a confidence score used to rank constraints and pick the
  // primary one. See the design spec referenced in the file header.
  const clamp = (x) => Math.max(0, Math.min(1, x));

  // Aggregate per station (ratios of summed ticks across parallel machines).
  const stationAgg = new Map(); // stationId -> aggregate
  for (const mc of machines) {
    const w = winTicks(mc);
    const totalTicks = w.proc + w.blocked + w.starved + w.idle;
    const a = stationAgg.get(mc.stationId) ?? {
      stationId: mc.stationId, proc: 0, blocked: 0, starved: 0, total: 0,
      // Parallel machines in a station share one input and one output buffer,
      // so the first machine's buffer ids represent the whole station.
      inputBufferId: mc.inputBufferId, outputBufferId: mc.outputBufferId,
    };
    a.proc    += w.proc;
    a.blocked += w.blocked;
    a.starved += w.starved;
    a.total   += totalTicks;
    stationAgg.set(mc.stationId, a);
  }
  for (const a of stationAgg.values()) {
    a.avgUtil      = a.total > 0 ? a.proc    / a.total : 0;
    a.blockedRatio = a.total > 0 ? a.blocked / a.total : 0;
    a.starvedRatio = a.total > 0 ? a.starved / a.total : 0;
    const inBuf = bufferById[a.inputBufferId] ?? null;
    a.inputFill  = inBuf && inBuf.capacity > 0 ? inBuf.load / inBuf.capacity : 0;
  }

  // Topology (linear chain): downstream station = the station whose input
  // buffer is this station's output buffer.
  const stationByInputBuffer = new Map();
  for (const a of stationAgg.values()) stationByInputBuffer.set(a.inputBufferId, a.stationId);
  for (const a of stationAgg.values()) {
    const downId = a.outputBufferId != null ? stationByInputBuffer.get(a.outputBufferId) : undefined;
    a.downstream = downId != null ? stationAgg.get(downId) : null;
  }

  // Gate + confidence score. Suppressed during warm-up (see WARMUP_TICKS): the
  // recent-window ratios are too noisy in the first few seconds to trust.
  const warmedUp = (state.tick ?? 0) >= WARMUP_TICKS;
  const constraints = [];
  for (const a of (warmedUp ? stationAgg.values() : [])) {
    const busy       = a.avgUtil > BOTTLENECK_UTIL_THRESHOLD;
    const notBlocked = a.blockedRatio < BLOCKED_MAX;
    if (!(busy && notBlocked)) continue;
    // A constraint paces everything after it, so a starved downstream is a
    // positive signal. The last station has no downstream to starve, so treat
    // its absence as a full positive signal (1) rather than missing evidence.
    const starveTerm = a.downstream ? clamp(a.downstream.starvedRatio) : 1;
    a.confidence =
        W_UTIL   * clamp(a.avgUtil)
      + W_BLOCK  * (1 - a.blockedRatio / BLOCKED_MAX)
      + W_STARVE * starveTerm
      + W_FILL   * clamp(a.inputFill);
    constraints.push(a);
  }
  constraints.sort((x, y) => y.confidence - x.confidence);

  const constraintStationIds = new Set(constraints.map(a => a.stationId));
  const primaryStationId     = constraints[0]?.stationId ?? null;

  // Write flags + flowState onto each machine (station-level verdict).
  machineMetrics.forEach(mm => {
    const a = stationAgg.get(mm.stationId);
    mm.bottleneck          = constraintStationIds.has(mm.stationId);
    mm.isPrimaryConstraint = mm.stationId === primaryStationId;
    mm.flowState =
        mm.bottleneck                 ? 'CONSTRAINT'
      : a.blockedRatio >= BLOCKED_MAX  ? 'BLOCKED_BY_DOWNSTREAM'
      : a.starvedRatio >= STARVED_MIN  ? 'STARVED_BY_UPSTREAM'
      :                                  'BALANCED';
  });

  // Source-starved guard: only relevant when NO internal constraint was found.
  const outputBuffers = new Set(
    [...stationAgg.values()].map(a => a.outputBufferId).filter(id => id != null)
  );
  const firstStation = [...stationAgg.values()].find(a => !outputBuffers.has(a.inputBufferId)) ?? null;
  const sourceStarved = firstStation != null && firstStation.starvedRatio >= STARVED_MIN;
  const anyBusy = [...stationAgg.values()].some(a => a.avgUtil > BOTTLENECK_UTIL_THRESHOLD);

  // Suggestions: one spawn per constraint with room, ranked by confidence.
  const suggestions = [];
  for (const a of constraints) {
    const stationMachines = machineMetrics.filter(mm => mm.stationId === a.stationId);
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) continue;
    const rep = stationMachines[0];
    suggestions.push({
      type: 'add-parallel-machine',
      stationId: a.stationId,
      machineId: rep.id,
      avgUtil: a.avgUtil,
      threshold: BOTTLENECK_UTIL_THRESHOLD,
      confidence: Math.round(a.confidence * 100) / 100,
      flowState: 'CONSTRAINT',
      label: `${rep.id} (${rep.name}) ist der Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
      reason: (() => {
        const util  = Math.round(a.avgUtil * 100);
        const block = Math.round(a.blockedRatio * 100);
        const fill  = Math.round(a.inputFill * 100);
        const downClause = a.downstream
          ? ` und die nachgelagerte Station wartet (${Math.round(a.downstream.starvedRatio * 100)}% Leerlauf)`
          : ' (letzte Station der Linie)';
        return `Erkannt, weil Station ${a.stationId} der Engpass ist: ${util}% Auslastung, `
             + `nur ${block}% blockiert${downClause} — Teile stauen sich davor `
             + `(Eingangspuffer ${fill}% voll). Ein blockierter Standort wäre dagegen `
             + `nur Opfer eines nachgelagerten Engpasses.`;
      })(),
    });
  }

  // Diagnostic note: no internal constraint, but the line is supply-limited or
  // everything is blocked. Emitted only when no station passed the gates.
  if (warmedUp && constraints.length === 0 && (sourceStarved || anyBusy)) {
    suggestions.push({
      type: 'no-internal-constraint',
      reason: 'Kein Engpass an den Maschinen — die Linie läuft im Gleichgewicht. '
            + 'Der Durchsatz wird vom Materialnachschub begrenzt (die Quelle liefert '
            + 'die Teile langsamer, als die Maschinen sie verarbeiten könnten). '
            + 'Zusätzliche Maschinen oder kürzere Taktzeiten bringen hier nichts; '
            + 'erhöhe stattdessen die Materialzufuhr, um mehr Durchsatz zu erreichen.',
    });
  }

  // ── Buffer metrics ─────────────────────────────────────────────────────────
  const bufferMetrics = buffers.map(b => ({
    id:               b.id,
    currentLoad:      b.load,
    capacity:         b.capacity,
    utilizationRatio: b.capacity > 0 ? b.load / b.capacity : 0,
  }));

  return {
    throughput:    Math.round(throughput * 100) / 100,
    avgLeadTime:   Math.round(avgLeadTime * 10) / 10,
    scrappedParts: scrap.partsReceived,
    machines:      machineMetrics,
    buffers:       bufferMetrics,
    simTime:       tick,
    partsInSystem,
    suggestions,
  };
}
