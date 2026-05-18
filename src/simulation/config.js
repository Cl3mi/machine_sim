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

  // Machines: name, cycleTime (ticks to process one part), and optional rejectRate
  machines: [
    { id: 'M1', name: 'Rohbearbeitung',    cycleTime: 4 },
    { id: 'M2', name: 'Qualitätsprüfung',  cycleTime: 3, rejectRate: 0.10 },
    { id: 'M3', name: 'Montage',           cycleTime: 5 },
    { id: 'M4', name: 'Verpackung',        cycleTime: 2 },
  ],

  // Buffers between stations (order: BUF0=Source→M1, BUF1=M1→M2, BUF2=M2→M3, BUF3=M3→M4)
  buffers: [
    { id: 'BUF0', capacity: 4 },
    { id: 'BUF1', capacity: 3 },
    { id: 'BUF2', capacity: 3 },
    { id: 'BUF3', capacity: 2 },
  ],
};
