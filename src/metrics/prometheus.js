/**
 * prometheus.js
 * Wraps collector.js output into prom-client Gauge/Counter objects.
 *
 * When Prometheus scrapes /metrics, this module asks the simulation engine
 * for the current state, runs calculateMetrics(), and updates all gauges.
 * The registry is then serialised to Prometheus text format.
 *
 * To add a new metric: add a Gauge/Counter below, then update it inside
 * updateMetrics() using the matching field from calculateMetrics().
 */

import { Registry, Gauge, Counter } from 'prom-client';
import { calculateMetrics } from './collector.js';

// Use a custom registry so we don't accidentally expose default Node.js metrics
const register = new Registry();
register.setDefaultLabels({ app: 'plantsim-poc' });

// ── Simulation-level gauges ────────────────────────────────────────────────

const gThroughput = new Gauge({
  name: 'plantsim_throughput_per_100_ticks',
  help: 'Parts completed per 100 simulation ticks',
  registers: [register],
});

const gAvgLeadTime = new Gauge({
  name: 'plantsim_avg_lead_time_ticks',
  help: 'Average lead time (source→sink) in simulation ticks',
  registers: [register],
});

const gLeadTimeP50 = new Gauge({
  name: 'plantsim_lead_time_p50_ticks',
  help: 'Median (p50) lead time over recent completed parts, in simulation ticks',
  registers: [register],
});

const gLeadTimeP95 = new Gauge({
  name: 'plantsim_lead_time_p95_ticks',
  help: '95th-percentile lead time over recent completed parts, in simulation ticks',
  registers: [register],
});

const gLeadTimeMax = new Gauge({
  name: 'plantsim_lead_time_max_ticks',
  help: 'Maximum lead time over recent completed parts, in simulation ticks',
  registers: [register],
});

const gLeadTimeStdDev = new Gauge({
  name: 'plantsim_lead_time_stddev_ticks',
  help: 'Standard deviation of lead time over recent completed parts, in simulation ticks',
  registers: [register],
});

const gFlowEfficiency = new Gauge({
  name: 'plantsim_flow_efficiency_ratio',
  help: 'Value-added ratio 0–1: theoretical processing time / average lead time',
  registers: [register],
});

const gPartsInSystem = new Gauge({
  name: 'plantsim_parts_in_system',
  help: 'Number of parts currently in the system (buffers + machines)',
  registers: [register],
});

const gScrappedParts = new Gauge({
  name: 'plantsim_scrapped_parts_total',
  help: 'Total parts scrapped at the quality gate',
  registers: [register],
});

const gSimTime = new Gauge({
  name: 'plantsim_simulation_tick',
  help: 'Current simulation tick',
  registers: [register],
});

// ── Per-machine gauges (labelled by machine id) ────────────────────────────

const gMachineUtilization = new Gauge({
  name: 'plantsim_machine_utilization_ratio',
  help: 'Machine utilization 0–1 (fraction of recent-window ticks spent PROCESSING)',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachineThroughput = new Gauge({
  name: 'plantsim_machine_throughput_per_100_ticks',
  help: 'Parts processed by this machine per 100 simulation ticks',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachineBlockedTime = new Gauge({
  name: 'plantsim_machine_blocked_ticks_total',
  help: 'Total ticks a machine spent in BLOCKED state',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachineStarvedTime = new Gauge({
  name: 'plantsim_machine_starved_ticks_total',
  help: 'Total ticks a machine spent in STARVED state',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachineAvgQueueWait = new Gauge({
  name: 'plantsim_machine_avg_queue_wait_ticks',
  help: 'Average ticks a part waited in the upstream buffer before this machine',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachineBottleneck = new Gauge({
  name: 'plantsim_machine_is_bottleneck',
  help: '1 if this machine is currently the identified bottleneck, 0 otherwise',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

const gMachinePrimaryConstraint = new Gauge({
  name: 'plantsim_machine_is_primary_constraint',
  help: '1 if this machine is the single primary constraint (highest-confidence bottleneck), 0 otherwise',
  labelNames: ['machine_id', 'machine_name'],
  registers: [register],
});

// ── Per-buffer gauges ──────────────────────────────────────────────────────

const gBufferLoad = new Gauge({
  name: 'plantsim_buffer_current_load',
  help: 'Current number of parts in the buffer',
  labelNames: ['buffer_id'],
  registers: [register],
});

const gBufferUtilization = new Gauge({
  name: 'plantsim_buffer_utilization_ratio',
  help: 'Buffer fill ratio (currentLoad / capacity)',
  labelNames: ['buffer_id'],
  registers: [register],
});

// ── Update function (called on each Prometheus scrape) ────────────────────

export function updateMetrics(engineState) {
  const m = calculateMetrics(engineState);

  gThroughput.set(m.throughput);
  gAvgLeadTime.set(m.avgLeadTime);
  gLeadTimeP50.set(m.leadTimeStats.p50);
  gLeadTimeP95.set(m.leadTimeStats.p95);
  gLeadTimeMax.set(m.leadTimeStats.max);
  gLeadTimeStdDev.set(m.leadTimeStats.stdDev);
  gFlowEfficiency.set(m.flowEfficiency);
  gPartsInSystem.set(m.partsInSystem);
  gScrappedParts.set(m.scrappedParts);
  gSimTime.set(m.simTime);

  // Clear per-machine series so removed machines don't linger as stale labels.
  gMachineUtilization.reset();
  gMachineThroughput.reset();
  gMachineBlockedTime.reset();
  gMachineStarvedTime.reset();
  gMachineAvgQueueWait.reset();
  gMachineBottleneck.reset();
  gMachinePrimaryConstraint.reset();

  for (const machine of m.machines) {
    const labels = { machine_id: machine.id, machine_name: machine.name };
    gMachineUtilization.set(labels,     machine.utilization);
    gMachineThroughput.set(labels,      machine.throughput);
    gMachineBlockedTime.set(labels,     machine.blockedTime);
    gMachineStarvedTime.set(labels,     machine.starvedTime);
    gMachineAvgQueueWait.set(labels,    machine.avgQueueWait);
    gMachineBottleneck.set(labels,      machine.bottleneck ? 1 : 0);
    gMachinePrimaryConstraint.set(labels, machine.isPrimaryConstraint ? 1 : 0);
  }

  for (const buffer of m.buffers) {
    gBufferLoad.set({ buffer_id: buffer.id },        buffer.currentLoad);
    gBufferUtilization.set({ buffer_id: buffer.id }, buffer.utilizationRatio);
  }
}

export { register };
