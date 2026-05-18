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
  const machineMetrics = machines.map(m => {
    const totalTicks = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
    const utilization = totalTicks > 0
      ? m.ticksProcessing / totalTicks
      : 0;

    // Average queue wait: accumulated wait ticks / parts that left the upstream buffer
    // We need the upstream buffer for this machine. M1=BUF0, M2=BUF1, M3=BUF2, M4=BUF3
    const machineIndex    = machines.indexOf(m);
    const upstreamBuffer  = buffers[machineIndex] ?? null;
    const avgQueueWait    = upstreamBuffer && upstreamBuffer.totalPartsOut > 0
      ? upstreamBuffer.totalWaitTicks / upstreamBuffer.totalPartsOut
      : 0;

    return {
      id:           m.id,
      name:         m.name,
      utilization,
      avgQueueWait,
      blockedTime:  m.ticksBlocked,
      starvedTime:  m.ticksStarved,
      currentState: m.state,
      bottleneck:   false, // filled in below
    };
  });

  // ── Bottleneck detection ───────────────────────────────────────────────────
  // The bottleneck is the machine with the highest ratio of (blocked + starved)
  // ticks relative to total runtime. A machine that is either waiting for
  // upstream parts OR holding finished parts because downstream is full is the
  // constraint on the whole line.
  let maxConstraintRatio = -1;
  let bottleneckIndex    = -1;

  machineMetrics.forEach((m, i) => {
    const raw = machines[i];
    const totalTicks = raw.ticksProcessing + raw.ticksBlocked + raw.ticksStarved + raw.ticksIdle;
    if (totalTicks === 0) return;
    // Use blocked time as the primary bottleneck signal:
    // A machine that is frequently BLOCKED is producing faster than downstream can consume.
    const ratio = raw.ticksBlocked / totalTicks;
    if (ratio > maxConstraintRatio) {
      maxConstraintRatio = ratio;
      bottleneckIndex    = i;
    }
  });

  // Only mark as bottleneck if it has meaningful blocked time (>5% of runtime)
  if (bottleneckIndex >= 0 && maxConstraintRatio > 0.05) {
    machineMetrics[bottleneckIndex].bottleneck = true;
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
  };
}
