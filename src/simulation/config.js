/**
 * config.js
 * Default simulation configuration. All values here can be overridden at
 * runtime via POST /api/control. Students: this is your main tuning knob —
 * change numbers here and observe the effect on throughput and bottlenecks.
 */

export const DEFAULT_CONFIG = {
  // Simulation clock: ticks per second of wall-clock time (affects animation speed)
  ticksPerSecond: 10,

  // Source node: generates one part every `sourceInterval` ticks.
  // Tuned (with the cycle times below) so M3 Montage is the single clear
  // bottleneck: the post-reject feed into M3 runs ~6% above one M3's capacity,
  // so parts visibly pile up in BUF2 (its input buffer) and back-pressure
  // blocks M1/M2 upstream. Adding ONE parallel machine to M3 still fully
  // resolves it without the constraint shifting to M1 — the supply rate stays
  // low enough that M1/M2/M4 sit well under the 60% utilization gate once M3's
  // capacity is doubled.
  source: {
    interval: 11,         // ticks between part generations
    materialStock: 200,   // how many parts can be produced before material runs out (-1 = infinite)
  },

  // Machines: each declares its station and the buffers it pulls from / pushes to.
  // outputBufferId:null means the machine pushes finished parts to the Sink.
  machines: [
    { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',    cycleTime: 4,                  inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
    { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung',  cycleTime: 3, rejectRate: 0.10, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
    { id: 'M3', stationId: 'S3', name: 'Montage',           cycleTime: 13,                 inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
    { id: 'M4', stationId: 'S4', name: 'Verpackung',        cycleTime: 2,                  inputBufferId: 'BUF3', outputBufferId: null   },
  ],

  // Buffers between stations (order: BUF0=Source→M1, BUF1=M1→M2, BUF2=M2→M3, BUF3=M3→M4)
  // BUF2 (the queue in front of the M3 bottleneck) is roomier so the work-in-
  // progress piling up ahead of the constraint is clearly visible.
  buffers: [
    { id: 'BUF0', capacity: 4 },
    { id: 'BUF1', capacity: 3 },
    { id: 'BUF2', capacity: 6 },
    { id: 'BUF3', capacity: 2 },
  ],
};
