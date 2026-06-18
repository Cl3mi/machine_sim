/**
 * presets.js
 * Curated, read-only teaching scenarios. Each preset is a COMPLETE simulation
 * config (same shape as DEFAULT_CONFIG) chosen to demonstrate one concept.
 * Users cannot add presets — they are code. Loaded via POST /api/control
 * { action: 'loadPreset', params: { presetId } }, which leaves the engine
 * paused at tick 0 so the user presses Start explicitly.
 */

export const PRESETS = [
  {
    id: 'bottleneck',
    label: 'Engpass (Montage)',
    description: 'Eine langsame Station (M3 Montage) wird zum klaren Engpass: davor staut es sich, dahinter herrscht Leerlauf.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 2, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 3,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 18,                  inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
  {
    id: 'max-throughput',
    label: 'Maximaler Durchsatz',
    description: 'Alle Stationen teilen sich dieselbe kurze Taktzeit und werden passend versorgt — höchster nachhaltiger Durchsatz bei nahezu vollständiger Auslastung, ohne Engpass oder Leerlauf.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 2, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 2,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 2, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 2,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 4 },
        { id: 'BUF2', capacity: 4 },
        { id: 'BUF3', capacity: 4 },
      ],
    },
  },
  {
    id: 'starvation',
    label: 'Materialmangel (Quelle)',
    description: 'Die Quelle liefert zu langsam — die Maschinen stehen die meiste Zeit ausgehungert (STARVED) still.',
    config: {
      ticksPerSecond: 10,
      source: { interval: 12, materialStock: 200 },
      machines: [
        { id: 'M1', stationId: 'S1', name: 'Rohbearbeitung',   cycleTime: 4,                   inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
        { id: 'M2', stationId: 'S2', name: 'Qualitätsprüfung', cycleTime: 3, rejectRate: 0.05, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
        { id: 'M3', stationId: 'S3', name: 'Montage',          cycleTime: 4,                   inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
        { id: 'M4', stationId: 'S4', name: 'Verpackung',       cycleTime: 2,                   inputBufferId: 'BUF3', outputBufferId: null   },
      ],
      buffers: [
        { id: 'BUF0', capacity: 4 },
        { id: 'BUF1', capacity: 3 },
        { id: 'BUF2', capacity: 3 },
        { id: 'BUF3', capacity: 2 },
      ],
    },
  },
];

// Returns a deep clone of the named preset's config, or undefined if unknown.
// Cloning protects the registry from mutation by the engine.
export function getPreset(id) {
  const preset = PRESETS.find(p => p.id === id);
  return preset ? JSON.parse(JSON.stringify(preset.config)) : undefined;
}
