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

// A station whose average machine utilization exceeds this is treated as the
// line's constraint (bottleneck). Tunable.
const BOTTLENECK_UTIL_THRESHOLD = 0.6;
// Keep in sync with engine MAX_MACHINES_PER_STATION — no point suggesting a
// spawn for a station that is already full.
const MAX_MACHINES_PER_STATION = 4;

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

  const machineMetrics = machines.map(m => {
    const totalTicks = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
    const utilization = totalTicks > 0 ? m.ticksProcessing / totalTicks : 0;

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
      currentState: m.state,
      bottleneck:   false, // filled in below
    };
  });

  // ── Bottleneck detection (station-level, utilization-based) ─────────────────
  // The constraint is the busiest STATION: the one whose machines spend the
  // largest share of time PROCESSING. (The previous blocked-ratio heuristic
  // flagged the machine *upstream* of the constraint — the wrong place to add
  // capacity.) Adding a parallel machine lowers per-machine utilization, so the
  // flagged bottleneck moves — the intended teaching feedback.
  const stationStats = new Map();   // stationId -> { utilSum, count }
  machineMetrics.forEach(mm => {
    const s = stationStats.get(mm.stationId) ?? { utilSum: 0, count: 0 };
    s.utilSum += mm.utilization;
    s.count   += 1;
    stationStats.set(mm.stationId, s);
  });

  let bottleneckStationId = null;
  let maxStationUtil      = -1;
  for (const [stationId, s] of stationStats) {
    const avgUtil = s.count > 0 ? s.utilSum / s.count : 0;
    if (avgUtil > maxStationUtil) {
      maxStationUtil      = avgUtil;
      bottleneckStationId = stationId;
    }
  }

  let suggestion = null;
  if (bottleneckStationId != null && maxStationUtil > BOTTLENECK_UTIL_THRESHOLD) {
    machineMetrics.forEach(mm => {
      if (mm.stationId === bottleneckStationId) mm.bottleneck = true;
    });

    const stationMachines = machineMetrics.filter(mm => mm.stationId === bottleneckStationId);
    if (stationMachines.length < MAX_MACHINES_PER_STATION) {
      const rep = stationMachines[0];
      suggestion = {
        type: 'add-parallel-machine',
        stationId: bottleneckStationId,
        machineId: rep.id,
        label: `${rep.id} (${rep.name}) ist ein Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
      };
    }
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
    suggestion,
  };
}
