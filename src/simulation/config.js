/**
 * config.js
 * Default simulation configuration. All values here can be overridden at
 * runtime via POST /api/control. Students: this is your main tuning knob —
 * change numbers here and observe the effect on throughput and bottlenecks.
 */

export const DEFAULT_CONFIG = {
  // Simulation clock: ticks per second of wall-clock time (affects animation speed)
  ticksPerSecond: 10,

  // Source node: generates one part every `sourceInterval` ticks
  source: {
    interval: 3,          // ticks between part generations
    materialStock: 200,   // how many parts can be produced before material runs out (-1 = infinite)
  },

  // Machines: each declares its station and the buffers it pulls from / pushes to.
  // outputBufferId:null means the machine pushes finished parts to the Sink.
  machines: [
    { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',    cycleTime: 4,                  inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
    { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung',  cycleTime: 3, rejectRate: 0.10, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
    { id: 'M3', stationId: 'S3', name: 'Montage',           cycleTime: 15,                 inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
    { id: 'M4', stationId: 'S4', name: 'Verpackung',        cycleTime: 2,                  inputBufferId: 'BUF3', outputBufferId: null   },
  ],

  // Buffers between stations (order: BUF0=Source→M1, BUF1=M1→M2, BUF2=M2→M3, BUF3=M3→M4)
  buffers: [
    { id: 'BUF0', capacity: 4 },
    { id: 'BUF1', capacity: 3 },
    { id: 'BUF2', capacity: 3 },
    { id: 'BUF3', capacity: 2 },
  ],
};
