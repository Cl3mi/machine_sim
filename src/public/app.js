/**
 * app.js
 * Frontend logic: SSE client, SVG pipeline renderer, control panel, metrics dashboard.
 *
 * No build step, no framework — pure ES modules so you can read every line.
 * The SSE stream pushes { state, metrics } every 500 ms; we redraw the SVG and
 * update the DOM on each push.
 */

// ── Layout constants (SVG coordinate system: 0 0 1400 300) ──────────────────

const SVG_W  = 1200;
const SVG_H  = 300;

// Y-centres for the main line and the scrap branch
const MAIN_Y  = 130;
const SCRAP_Y = 240;

// Widths / heights for element shapes
const SRC_W  = 80;  const SRC_H  = 80;
const MACH_W = 110; const MACH_H = 80;
const BUF_W  = 70;  const BUF_H  = 60;
const SINK_W = 70;  const SINK_H = 70;

// Horizontal positions of each element (left edge of its bounding box)
const LAYOUT = {
  SOURCE: 20,
  BUF0:   130,
  M1:     230,
  BUF1:   370,
  M2:     460,
  BUF2:   600,
  M3:     690,
  BUF3:   830,
  M4:     920,
  SINK:   1060,
  SCRAP:  560,  // x of scrap box (below M2 fork)
};

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

// ── Transfer detection (pure: prev/next state -> particle spawn events) ──
// Each event: { connectorId, kind: 'good'|'scrap', count }

function detectTransfers(prev, next) {
  if (!prev || !next) return [];
  const events = [];

  const bufBy = (state, id) =>
    state.buffers.find(b => b.id === id) ?? { totalPartsOut: 0, load: 0, capacity: 0 };
  const machBy = (state, id) =>
    state.machines.find(m => m.id === id) ?? { partsProcessed: 0 };
  const sourceOf = (state) => state.source ?? { totalGenerated: 0 };
  const scrapOf  = (state) => state.scrap  ?? { partsReceived: 0 };

  // Source -> BUF0
  const srcDelta = sourceOf(next).totalGenerated - sourceOf(prev).totalGenerated;
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
  const m2sd = scrapOf(next).partsReceived - scrapOf(prev).partsReceived;
  if (m2sd > 0)            events.push({ connectorId: 'conn-m2-scrap', kind: 'scrap', count: m2sd });
  const m2good = Math.max(0, m2d - m2sd);
  if (m2good > 0)          events.push({ connectorId: 'conn-m2-b2', kind: 'good', count: m2good });

  const m3d = machBy(next, 'M3').partsProcessed - machBy(prev, 'M3').partsProcessed;
  if (m3d > 0) events.push({ connectorId: 'conn-m3-b3', kind: 'good', count: m3d });

  const m4d = machBy(next, 'M4').partsProcessed - machBy(prev, 'M4').partsProcessed;
  if (m4d > 0) events.push({ connectorId: 'conn-m4-sink', kind: 'good', count: m4d });

  return events;
}

// ── Status descriptions (short, human-readable) ──────────────────────────────
const STATE_DESCRIPTION = {
  PROCESSING: 'Bearbeitet',
  IDLE:       'Leerlauf',
  STARVED:    'Ausgehungert',
  BLOCKED:    'Blockiert',
};

// ── State ────────────────────────────────────────────────────────────────────

let lastState   = null;
let lastMetrics = null;
let prevStateForDiff = null;
let selectedMachineId = null;   // null = panel closed; otherwise 'M1'..'M4'

const sparklineData = [];   // rolling window of throughput values
const SPARKLINE_LEN = 60;

// ── SVG helpers ──────────────────────────────────────────────────────────────

const svg = document.getElementById('pipeline-svg');

function el(tag, attrs = {}) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function txt(content, attrs = {}) {
  const t = el('text', { 'font-family': 'monospace', 'font-size': '11', fill: '#e2e8f0', ...attrs });
  t.textContent = content;
  return t;
}

// ── Initial SVG draw (static skeleton) ───────────────────────────────────────
// We draw the structure once; dynamic parts get IDs and are updated every frame.

function buildPipeline() {
  svg.innerHTML = '';   // clear on reset

  // ── Connector lines ────────────────────────────────────────────────────────

  const connectors = [
    // id,         x1,                          y1,      x2,                    y2
    ['conn-src-b0', LAYOUT.SOURCE + SRC_W,      MAIN_Y,  LAYOUT.BUF0,           MAIN_Y],
    ['conn-b0-m1',  LAYOUT.BUF0  + BUF_W,      MAIN_Y,  LAYOUT.M1,             MAIN_Y],
    ['conn-m1-b1',  LAYOUT.M1    + MACH_W,     MAIN_Y,  LAYOUT.BUF1,           MAIN_Y],
    ['conn-b1-m2',  LAYOUT.BUF1  + BUF_W,      MAIN_Y,  LAYOUT.M2,             MAIN_Y],
    ['conn-m2-b2',  LAYOUT.M2    + MACH_W,     MAIN_Y,  LAYOUT.BUF2,           MAIN_Y],
    ['conn-b2-m3',  LAYOUT.BUF2  + BUF_W,      MAIN_Y,  LAYOUT.M3,             MAIN_Y],
    ['conn-m3-b3',  LAYOUT.M3    + MACH_W,     MAIN_Y,  LAYOUT.BUF3,           MAIN_Y],
    ['conn-b3-m4',  LAYOUT.BUF3  + BUF_W,      MAIN_Y,  LAYOUT.M4,             MAIN_Y],
    ['conn-m4-sink',LAYOUT.M4    + MACH_W,     MAIN_Y,  LAYOUT.SINK,           MAIN_Y],
  ];

  for (const [id, x1, y1, x2, y2] of connectors) {
    const line = el('line', { id, x1, y1, x2, y2, class: 'pipe-connector' });
    svg.appendChild(line);
  }

  // Scrap branch: vertical drop from M2 centre down to SCRAP_Y, then horizontal to scrap box
  const m2CentreX = LAYOUT.M2 + MACH_W / 2;
  const m2Bottom  = MAIN_Y + MACH_H / 2;
  const scrapPath = el('path', {
    id: 'conn-m2-scrap',
    d: `M ${m2CentreX} ${m2Bottom} L ${m2CentreX} ${SCRAP_Y} L ${LAYOUT.SCRAP + SINK_W} ${SCRAP_Y}`,
    class: 'pipe-connector',
  });
  svg.appendChild(scrapPath);

  // Scrap label on the branch
  const scrapLabel = txt('reject', { x: m2CentreX + 4, y: SCRAP_Y - 6, fill: '#ef4444', 'font-size': '10' });
  svg.appendChild(scrapLabel);

  const scrapRateLabel = txt('10%', { id: 'scrap-rate-label', x: m2CentreX + 4, y: SCRAP_Y + 14, fill: '#f87171', 'font-size': '10' });
  svg.appendChild(scrapRateLabel);

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

  cacheConnectorGeometry();

  particlePool = [];   // particle <circle>s lived inside #particle-layer
  particles    = [];
  ensureParticleNodes(32);
  startParticleLoop();

  // ── Source ─────────────────────────────────────────────────────────────────
  drawSource();

  // ── Buffers ────────────────────────────────────────────────────────────────
  drawBuffer('BUF0', LAYOUT.BUF0, MAIN_Y - BUF_H / 2, 4);
  drawBuffer('BUF1', LAYOUT.BUF1, MAIN_Y - BUF_H / 2, 3);
  drawBuffer('BUF2', LAYOUT.BUF2, MAIN_Y - BUF_H / 2, 3);
  drawBuffer('BUF3', LAYOUT.BUF3, MAIN_Y - BUF_H / 2, 2);

  // ── Machines ───────────────────────────────────────────────────────────────
  drawMachine('M1', LAYOUT.M1, MAIN_Y - MACH_H / 2, 'Rohbearbeitung',   4);
  drawMachine('M2', LAYOUT.M2, MAIN_Y - MACH_H / 2, 'Qualitätsprüfung', 3);
  drawMachine('M3', LAYOUT.M3, MAIN_Y - MACH_H / 2, 'Montage',          5);
  drawMachine('M4', LAYOUT.M4, MAIN_Y - MACH_H / 2, 'Verpackung',       2);

  // ── Sink ───────────────────────────────────────────────────────────────────
  drawSink(LAYOUT.SINK, MAIN_Y - SINK_H / 2);

  // ── Scrap sink ─────────────────────────────────────────────────────────────
  drawScrapSink(LAYOUT.SCRAP, SCRAP_Y - SINK_H / 2);
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawSource() {
  const x = LAYOUT.SOURCE;
  const y = MAIN_Y - SRC_H / 2;
  const g = el('g', { id: 'elem-SOURCE' });

  g.appendChild(el('rect', { x, y, width: SRC_W, height: SRC_H, rx: 6,
    fill: '#1a1d27', stroke: '#4f46e5', 'stroke-width': 1.5 }));

  // Stock bar background
  g.appendChild(el('rect', { id: 'src-stock-bg', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#252836' }));
  // Stock bar fill (width updated dynamically)
  g.appendChild(el('rect', { id: 'src-stock-fill', x: x + 8, y: y + SRC_H - 20, width: SRC_W - 16, height: 10,
    rx: 3, fill: '#6366f1' }));

  g.appendChild(txt('SOURCE', { x: x + SRC_W / 2, y: y + 18, 'text-anchor': 'middle', 'font-size': '10', fill: '#818cf8' }));
  g.appendChild(txt('', { id: 'src-stock-text', x: x + SRC_W / 2, y: y + 38, 'text-anchor': 'middle', 'font-size': '11' }));

  svg.appendChild(g);
}

function drawBuffer(id, x, y, defaultCap) {
  const g = el('g', { id: `elem-${id}` });

  g.appendChild(el('rect', { x, y, width: BUF_W, height: BUF_H, rx: 5,
    fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.2 }));

  g.appendChild(txt(id, { x: x + BUF_W / 2, y: y + 13, 'text-anchor': 'middle', 'font-size': '9', fill: '#64748b' }));

  // Load / capacity text
  g.appendChild(txt('0/4', { id: `buf-load-${id}`, x: x + BUF_W / 2, y: y + BUF_H - 5, 'text-anchor': 'middle', 'font-size': '10' }));

  // Slots — rendered as a row of small squares
  const slotGroup = el('g', { id: `buf-slots-${id}` });
  g.appendChild(slotGroup);

  svg.appendChild(g);
}

function drawMachine(id, x, y, name, cycleTime) {
  const g = el('g', { id: `elem-${id}` });
  g.addEventListener('click', () => openMachineDetail(id));

  // Background rect
  g.appendChild(el('rect', { id: `mach-rect-${id}`, x, y, width: MACH_W, height: MACH_H,
    rx: 8, class: 'machine-rect IDLE', fill: '#1a1d27', stroke: '#2e3347', 'stroke-width': 1.5 }));

  // Machine name (top)
  const shortName = name.length > 17 ? name.slice(0, 16) + '…' : name;
  g.appendChild(txt(shortName, { x: x + MACH_W / 2, y: y + 11, 'text-anchor': 'middle',
    'font-size': '9.5', fill: '#94a3b8' }));
  g.appendChild(txt(id, { x: x + MACH_W / 2, y: y + 22, 'text-anchor': 'middle',
    'font-size': '9', fill: '#64748b' }));

  // Progress arc (circle)
  const cx = x + MACH_W / 2;
  const cy = y + MACH_H / 2 + 6;
  const r  = 20;
  const circ = 2 * Math.PI * r;

  // Background circle
  g.appendChild(el('circle', { cx, cy, r, fill: 'none', stroke: '#252836', 'stroke-width': 4 }));

  // Progress arc — dasharray trick: stroke-dashoffset controls how much is shown
  const arc = el('circle', {
    id: `mach-arc-${id}`, cx, cy, r, fill: 'none',
    stroke: '#22c55e', 'stroke-width': 4,
    'stroke-dasharray': circ.toFixed(2),
    'stroke-dashoffset': circ.toFixed(2),  // 0% progress initially
    transform: `rotate(-90 ${cx} ${cy})`,  // start arc at 12 o'clock
  });
  g.appendChild(arc);

  // Utilization % inside the circle
  g.appendChild(txt('0%', { id: `mach-util-${id}`, cx, cy,
    x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': '9', fill: '#94a3b8' }));

  // State badge (bottom-left of machine rect)
  g.appendChild(el('rect', { id: `mach-badge-bg-${id}`, x: x + 4, y: y + MACH_H - 18, width: 50, height: 14,
    rx: 7, fill: '#1e293b' }));
  g.appendChild(txt('IDLE', { id: `mach-badge-${id}`, x: x + 29, y: y + MACH_H - 7,
    'text-anchor': 'middle', 'font-size': '8', fill: '#94a3b8' }));

  // Bottleneck marker (hidden by default — shown when this machine is the bottleneck)
  const bnG = el('g', { id: `mach-bn-${id}`, class: 'mach-bn-marker', visibility: 'hidden' });
  const badgeW = 78;
  const badgeH = 18;
  const badgeX = x + MACH_W / 2 - badgeW / 2;
  const badgeY = y - badgeH - 10;            // sits above the machine
  bnG.appendChild(el('rect', {
    x: badgeX, y: badgeY, width: badgeW, height: badgeH, rx: 9,
    fill: '#7c2d12', stroke: '#f97316', 'stroke-width': 1.2,
  }));
  // Warning glyph + label
  bnG.appendChild(txt('⚠ ENGPASS', {
    x: x + MACH_W / 2, y: badgeY + badgeH - 5,
    'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
    fill: '#fdba74', 'font-family': 'Inter, system-ui, sans-serif',
  }));
  // Arrow pointing down to the machine
  const arrowTopY = badgeY + badgeH;
  const arrowTipY = y - 1;
  const arrowCx   = x + MACH_W / 2;
  bnG.appendChild(el('polygon', {
    points: `${arrowCx - 5},${arrowTopY} ${arrowCx + 5},${arrowTopY} ${arrowCx},${arrowTipY}`,
    fill: '#f97316',
  }));
  g.appendChild(bnG);

  svg.appendChild(g);
}

function drawSink(x, y) {
  const g = el('g', { id: 'elem-SINK' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#22c55e', 'stroke-width': 1.5 }));
  g.appendChild(txt('SINK', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#86efac' }));
  g.appendChild(txt('0', { id: 'sink-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#22c55e', 'font-weight': 'bold' }));
  g.appendChild(txt('parts', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#4ade80' }));
  svg.appendChild(g);
}

function drawScrapSink(x, y) {
  const g = el('g', { id: 'elem-SCRAP' });
  g.appendChild(el('rect', { x, y, width: SINK_W, height: SINK_H, rx: 6,
    fill: '#1a1d27', stroke: '#ef4444', 'stroke-width': 1.5 }));
  g.appendChild(txt('SCRAP', { x: x + SINK_W / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': '10', fill: '#f87171' }));
  g.appendChild(txt('0', { id: 'scrap-count', x: x + SINK_W / 2, y: y + 40, 'text-anchor': 'middle',
    'font-size': '20', fill: '#ef4444', 'font-weight': 'bold' }));
  g.appendChild(txt('scrapped', { x: x + SINK_W / 2, y: y + SINK_H - 6, 'text-anchor': 'middle', 'font-size': '9', fill: '#fca5a5' }));
  svg.appendChild(g);
}

// ── Dynamic update: redraw state each frame ───────────────────────────────────

function updatePipeline(state, metrics) {
  if (!state) return;

  // ── Source ─────────────────────────────────────────────────────────────────
  const src         = state.source;
  const stockFill   = document.getElementById('src-stock-fill');
  const stockText   = document.getElementById('src-stock-text');
  const initialStock = 200; // keep in sync with DEFAULT_CONFIG — used for bar scaling

  if (stockFill) {
    const ratio = src.materialStock > 0 ? Math.min(src.materialStock / initialStock, 1) : 0;
    const maxW  = SRC_W - 16;
    stockFill.setAttribute('width', (ratio * maxW).toFixed(1));
    stockFill.setAttribute('fill', ratio > 0.3 ? '#6366f1' : ratio > 0.1 ? '#f59e0b' : '#ef4444');
  }
  if (stockText) {
    stockText.textContent = src.materialStock === 0 ? '∞' : src.materialStock;
  }

  // ── Buffers ────────────────────────────────────────────────────────────────
  for (const buf of state.buffers) {
    updateBufferSlots(buf);
  }

  // ── Machines ───────────────────────────────────────────────────────────────
  const metricsMap = {};
  if (metrics && metrics.machines) {
    for (const m of metrics.machines) metricsMap[m.id] = m;
  }

  for (const m of state.machines) {
    updateMachine(m, metricsMap[m.id]);
  }

  // ── Connector colours (blocked = red) ──────────────────────────────────────
  // A connector is "blocked" if the buffer at its destination is full
  const bufMap = {};
  for (const b of state.buffers) bufMap[b.id] = b;

  setConnectorBlocked('conn-src-b0', bufMap.BUF0?.load >= bufMap.BUF0?.capacity);
  setConnectorBlocked('conn-b0-m1',  false);
  setConnectorBlocked('conn-m1-b1',  bufMap.BUF1?.load >= bufMap.BUF1?.capacity);
  setConnectorBlocked('conn-b1-m2',  false);
  setConnectorBlocked('conn-m2-b2',  bufMap.BUF2?.load >= bufMap.BUF2?.capacity);
  setConnectorBlocked('conn-b2-m3',  false);
  setConnectorBlocked('conn-m3-b3',  bufMap.BUF3?.load >= bufMap.BUF3?.capacity);
  setConnectorBlocked('conn-b3-m4',  false);

  // ── Sink / Scrap counts ────────────────────────────────────────────────────
  setTextContent('sink-count',  state.sink.partsReceived);
  setTextContent('scrap-count', state.scrap.partsReceived);

  // Update scrap rate label (M2 rejectRate)
  const m2 = state.machines.find(m => m.id === 'M2');
  if (m2) {
    setTextContent('scrap-rate-label', (m2.rejectRate * 100).toFixed(0) + '%');
  }

  // ── Machine detail panel (if open) ─────────────────────────────────────────
  updateMachineDetail();

  // ── Header tick ────────────────────────────────────────────────────────────
  setTextContent('tick-counter', state.tick);
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (dot && label) {
    if (state.running) {
      dot.className   = 'status-dot running';
      label.textContent = 'Running';
    } else {
      dot.className   = 'status-dot';
      label.textContent = 'Paused';
    }
  }
}

function updateBufferSlots(buf) {
  const slotGroup = document.getElementById(`buf-slots-${buf.id}`);
  const loadLabel = document.getElementById(`buf-load-${buf.id}`);
  if (!slotGroup) return;

  if (loadLabel) loadLabel.textContent = `${buf.load}/${buf.capacity}`;

  // Rebuild slots (capacity might have changed via slider)
  slotGroup.innerHTML = '';
  const cap   = buf.capacity;
  const elemX = LAYOUT[buf.id];
  const elemY = MAIN_Y - BUF_H / 2;

  // Determine slot sizing to fit within buffer box
  const slotSize = Math.min(14, (BUF_W - 10) / cap - 3);
  const totalW   = cap * slotSize + (cap - 1) * 3;
  const startX   = elemX + (BUF_W - totalW) / 2;
  const slotY    = elemY + BUF_H / 2 - slotSize / 2 - 4;

  const fillRatio = cap > 0 ? buf.load / cap : 0;

  for (let i = 0; i < cap; i++) {
    const occupied = i < buf.load;
    const sx = startX + i * (slotSize + 3);
    let cls = occupied ? 'buf-slot-full' : 'buf-slot-empty';
    if (occupied && fillRatio > 0.99) cls += ' alert';
    else if (occupied && fillRatio > 0.75) cls += ' warn';

    slotGroup.appendChild(el('rect', {
      x: sx, y: slotY, width: slotSize, height: slotSize, rx: 2, class: cls,
    }));
  }
}

function updateMachine(m, mMetrics) {
  const arcEl    = document.getElementById(`mach-arc-${m.id}`);
  const badgeEl  = document.getElementById(`mach-badge-${m.id}`);
  const badgeBg  = document.getElementById(`mach-badge-bg-${m.id}`);
  const utilEl   = document.getElementById(`mach-util-${m.id}`);
  const rectEl   = document.getElementById(`mach-rect-${m.id}`);

  if (!arcEl) return;

  // Progress arc: stroke-dashoffset goes from full-circumference (0%) to 0 (100%)
  const r    = 20;
  const circ = 2 * Math.PI * r;
  const progress = m.cycleTime > 0 ? 1 - (m.ticksLeft / m.cycleTime) : 0;
  const offset   = circ * (1 - Math.max(0, Math.min(1, progress)));
  arcEl.setAttribute('stroke-dashoffset', offset.toFixed(2));

  // Arc colour by state
  const arcColours = { PROCESSING: '#22c55e', IDLE: '#2e3347', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
  arcEl.setAttribute('stroke', arcColours[m.state] ?? '#2e3347');

  // State badge
  if (badgeEl) {
    badgeEl.textContent = m.state;
    const textColours = { PROCESSING: '#86efac', IDLE: '#94a3b8', STARVED: '#fde68a', BLOCKED: '#fca5a5' };
    badgeEl.setAttribute('fill', textColours[m.state] ?? '#94a3b8');
  }
  if (badgeBg) {
    const bgColours = { PROCESSING: '#166534', IDLE: '#1e293b', STARVED: '#713f12', BLOCKED: '#7f1d1d' };
    badgeBg.setAttribute('fill', bgColours[m.state] ?? '#1e293b');
  }

  // Machine rect stroke by state + bottleneck + selection
  const isBottleneck = mMetrics?.bottleneck ?? false;
  const bnMarker = document.getElementById(`mach-bn-${m.id}`);
  if (bnMarker) bnMarker.setAttribute('visibility', isBottleneck ? 'visible' : 'hidden');

  if (rectEl) {
    const isSelected   = selectedMachineId === m.id;
    let stateClass = `machine-rect ${m.state}`;
    if (isBottleneck) stateClass = 'machine-rect bottleneck';
    if (isSelected)   stateClass += ' selected';
    rectEl.setAttribute('class', stateClass);
    const strokeColours = { PROCESSING: '#22c55e', IDLE: '#2e3347', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
    const baseStroke   = isBottleneck ? '#f97316' : (strokeColours[m.state] ?? '#2e3347');
    rectEl.setAttribute('stroke', isSelected ? '#818cf8' : baseStroke);
  }

  // Utilization
  if (utilEl && mMetrics) {
    utilEl.textContent = (mMetrics.utilization * 100).toFixed(0) + '%';
  }
}

// ── Machine detail panel ─────────────────────────────────────────────────────

function openMachineDetail(id) {
  selectedMachineId = id;
  const panel = document.getElementById('machine-detail');
  if (panel) panel.hidden = false;
  // Push an immediate render so the panel populates before the next SSE frame
  updateMachineDetail();
  if (lastState) {
    // Re-run machine rect update so the selection ring appears immediately
    const metricsMap = {};
    if (lastMetrics?.machines) for (const m of lastMetrics.machines) metricsMap[m.id] = m;
    for (const m of lastState.machines) updateMachine(m, metricsMap[m.id]);
  }
}

function closeMachineDetail() {
  const prev = selectedMachineId;
  selectedMachineId = null;
  const panel = document.getElementById('machine-detail');
  if (panel) panel.hidden = true;
  if (prev && lastState) {
    const metricsMap = {};
    if (lastMetrics?.machines) for (const m of lastMetrics.machines) metricsMap[m.id] = m;
    for (const m of lastState.machines) updateMachine(m, metricsMap[m.id]);
  }
}

function updateMachineDetail() {
  if (!selectedMachineId || !lastState) return;
  const panel = document.getElementById('machine-detail');
  if (!panel || panel.hidden) return;

  const m = lastState.machines.find(x => x.id === selectedMachineId);
  if (!m) return;
  const mm = lastMetrics?.machines?.find(x => x.id === selectedMachineId);

  setTextContent('md-id',   m.id);
  setTextContent('md-name', m.name);

  const bn = document.getElementById('md-bottleneck');
  if (bn) bn.hidden = !(mm?.bottleneck);

  const stateEl = document.getElementById('md-state');
  if (stateEl) {
    stateEl.textContent = m.state;
    stateEl.className   = `state-badge state-${m.state}`;
  }
  setTextContent('md-state-desc', STATE_DESCRIPTION[m.state] ?? '');

  setTextContent('md-part', m.currentPartId != null ? `#${m.currentPartId}` : '—');

  // Cycle progress
  const elapsed = m.cycleTime - m.ticksLeft;
  setTextContent('md-cycle-text', `${Math.max(0, elapsed)} / ${m.cycleTime} ticks`);
  const fill = document.getElementById('md-cycle-fill');
  if (fill) {
    const ratio = m.cycleTime > 0 ? Math.max(0, Math.min(1, elapsed / m.cycleTime)) : 0;
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    const fillColours = { PROCESSING: '#22c55e', IDLE: '#64748b', STARVED: '#f59e0b', BLOCKED: '#ef4444' };
    fill.style.background = fillColours[m.state] ?? '#64748b';
  }

  // Stats
  setTextContent('md-util',      ((mm?.utilization ?? 0) * 100).toFixed(1) + '%');
  setTextContent('md-processed', m.partsProcessed);
  setTextContent('md-wait',      (mm?.avgQueueWait ?? 0).toFixed(1) + ' ticks');

  // Reject rate only meaningful for the quality gate (M2 or any non-zero)
  const rejectStat = document.getElementById('md-reject-stat');
  if (rejectStat) {
    if (m.rejectRate && m.rejectRate > 0) {
      rejectStat.hidden = false;
      setTextContent('md-reject', (m.rejectRate * 100).toFixed(0) + '%');
    } else {
      rejectStat.hidden = true;
    }
  }

  // Time breakdown stacked bar
  const total = m.ticksProcessing + m.ticksBlocked + m.ticksStarved + m.ticksIdle;
  setTextContent('md-total-ticks', `${total} ticks`);
  const segs = {
    processing: total > 0 ? m.ticksProcessing / total : 0,
    blocked:    total > 0 ? m.ticksBlocked    / total : 0,
    starved:    total > 0 ? m.ticksStarved    / total : 0,
    idle:       total > 0 ? m.ticksIdle       / total : 0,
  };
  const stack = document.getElementById('md-stack');
  if (stack) {
    stack.children[0].style.width = (segs.processing * 100).toFixed(2) + '%';
    stack.children[1].style.width = (segs.blocked    * 100).toFixed(2) + '%';
    stack.children[2].style.width = (segs.starved    * 100).toFixed(2) + '%';
    stack.children[3].style.width = (segs.idle       * 100).toFixed(2) + '%';
  }
  setTextContent('md-pct-processing', (segs.processing * 100).toFixed(0) + '%');
  setTextContent('md-pct-blocked',    (segs.blocked    * 100).toFixed(0) + '%');
  setTextContent('md-pct-starved',    (segs.starved    * 100).toFixed(0) + '%');
  setTextContent('md-pct-idle',       (segs.idle       * 100).toFixed(0) + '%');
}

function setConnectorBlocked(id, blocked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('class', blocked ? 'pipe-connector blocked' : 'pipe-connector');
  el.setAttribute('stroke', blocked ? '#ef4444' : '#2e3347');
}

function setTextContent(id, value) {
  const e = document.getElementById(id);
  if (e) e.textContent = value;
}

// ── Metrics dashboard update ──────────────────────────────────────────────────

function updateMetricsDashboard(metrics, state) {
  if (!metrics) return;

  setTextContent('m-throughput',  metrics.throughput.toFixed(1));
  setTextContent('m-leadtime',    metrics.avgLeadTime.toFixed(1));
  setTextContent('m-in-system',   metrics.partsInSystem);
  setTextContent('m-scrapped',    metrics.scrappedParts);

  // Sparkline data — only advance while running so the chart freezes on pause
  if (state && state.running) {
    sparklineData.push(metrics.throughput);
    if (sparklineData.length > SPARKLINE_LEN) sparklineData.shift();
    drawSparkline();
  }

  // Machine table
  const tbody = document.getElementById('machine-table-body');
  if (!tbody || !metrics.machines) return;
  tbody.innerHTML = '';

  for (const m of metrics.machines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.id}</strong> — ${m.name}${m.bottleneck ? '<span class="bottleneck-badge">Engpass</span>' : ''}</td>
      <td><span class="state-badge state-${m.currentState}">${m.currentState}</span> <span class="state-desc">${STATE_DESCRIPTION[m.currentState] ?? ''}</span></td>
      <td>${(m.utilization * 100).toFixed(1)}%</td>
      <td>${m.avgQueueWait.toFixed(1)} ticks</td>
      <td>${m.blockedTime} ticks</td>
      <td>${m.starvedTime} ticks</td>
      <td>${m.bottleneck ? '&#9888; Yes' : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Sparkline canvas chart ─────────────────────────────────────────────────────

function drawSparkline() {
  const canvas = document.getElementById('sparkline');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W      = canvas.offsetWidth;
  const H      = canvas.offsetHeight;
  canvas.width  = W;
  canvas.height = H;

  ctx.clearRect(0, 0, W, H);

  if (sparklineData.length < 2) return;

  const max  = Math.max(...sparklineData, 1);
  const step = W / (SPARKLINE_LEN - 1);

  ctx.beginPath();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';

  for (let i = 0; i < sparklineData.length; i++) {
    const x = i * step;
    const y = H - (sparklineData[i] / max) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill area under the line
  ctx.lineTo((sparklineData.length - 1) * step, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(99,102,241,0.15)';
  ctx.fill();
}

// ── Particle engine ───────────────────────────────────────────────────────
// In-flight particles travelling between stations. Driven by rAF.

const PARTICLE_DURATION_MS = 400;   // travel time at 1× sim speed
const PARTICLE_RADIUS      = 3.5;
const POOL_GROWTH          = 16;
const POOL_MAX_SIZE        = 256;

let particleSimState = null;   // latest server snapshot, used for jam checks
let particleSimPaused = false;
let particlePool = [];      // { node: <circle> head, tail: <circle>, inUse: boolean }
let particles    = [];      // active Particle objects
let lastFrameTs  = 0;
let rafHandle    = null;

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

function acquireParticleNode() {
  for (const slot of particlePool) {
    if (!slot.inUse) {
      slot.inUse = true;
      slot.node.classList.remove('hidden');
      slot.tail.classList.remove('hidden');
      return slot;
    }
  }
  if (particlePool.length >= POOL_MAX_SIZE) return null;
  ensureParticleNodes(Math.min(POOL_MAX_SIZE, particlePool.length + POOL_GROWTH));
  return acquireParticleNode();
}

function releaseParticleNode(slot) {
  slot.inUse = false;
  slot.node.classList.add('hidden');
  slot.tail.classList.add('hidden');
}

function isDestBufferFull(connectorId) {
  if (!particleSimState) return false;
  const conn = CONNECTORS.find(c => c.id === connectorId);
  if (!conn || !conn.destBufferId) return false;
  const buf = particleSimState.buffers.find(b => b.id === conn.destBufferId);
  if (!buf) return false;
  return buf.load >= buf.capacity;
}

function spawnParticle({ connectorId, kind, delayMs = 0 }) {
  if (!connectorPointAt[connectorId]) return;
  const slot = acquireParticleNode();
  if (!slot) return;   // pool exhausted; drop this spawn
  if (kind === 'scrap') slot.node.classList.add('scrap');
  else                  slot.node.classList.remove('scrap');
  if (kind === 'scrap') slot.tail.classList.add('scrap');
  else                  slot.tail.classList.remove('scrap');

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

  // Group jammed particles per-connector so we can assign stack indexes.
  const jamStackCounters = {};   // connectorId -> next stackIndex

  // Walk in spawn order (oldest first) so older particles sit deeper
  // into the jam (closer to the buffer wall).
  for (let i = 0; i < particles.length; i++) {
    const p   = particles[i];
    const fn  = connectorPointAt[p.connectorId];
    if (!fn) {
      releaseParticleNode(p.slot);
      particles.splice(i, 1);
      i--;
      continue;
    }

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

    const pt = fn(t);
    p.slot.node.setAttribute('cx', pt.x.toFixed(2));
    p.slot.node.setAttribute('cy', pt.y.toFixed(2));
    const tailT = Math.max(0, t - 0.08);
    const tailPt = fn(tailT);
    p.slot.tail.setAttribute('cx', tailPt.x.toFixed(2));
    p.slot.tail.setAttribute('cy', tailPt.y.toFixed(2));
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

function startParticleLoop() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(particleLoop);
}

function resetParticles() {
  for (const p of particles) releaseParticleNode(p.slot);
  particles = [];
}

// ── Control panel ─────────────────────────────────────────────────────────────

function buildControlSliders(state) {
  // Machine cycle time sliders
  const machineSliders = document.getElementById('machine-sliders');
  // Remove all children except the label span
  [...machineSliders.children].forEach(c => {
    if (!c.classList.contains('section-label')) c.remove();
  });

  for (const m of state.machines) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${m.id} cycle time <span id="val-ct-${m.id}">${m.cycleTime}</span></label>
      <input type="range" id="ct-${m.id}" min="1" max="15" step="1" value="${m.cycleTime}" />
    `;
    machineSliders.appendChild(div);
    div.querySelector('input').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      document.getElementById(`val-ct-${m.id}`).textContent = v;
      postControl({ machineId: m.id, cycleTime: v });
    });
  }

  // Buffer capacity sliders
  const bufferSliders = document.getElementById('buffer-sliders');
  [...bufferSliders.children].forEach(c => {
    if (!c.classList.contains('section-label')) c.remove();
  });

  for (const b of state.buffers) {
    const div = document.createElement('div');
    div.className = 'slider-group';
    div.innerHTML = `
      <label>${b.id} capacity <span id="val-cap-${b.id}">${b.capacity}</span></label>
      <input type="range" id="cap-${b.id}" min="1" max="10" step="1" value="${b.capacity}" />
    `;
    bufferSliders.appendChild(div);
    div.querySelector('input').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      document.getElementById(`val-cap-${b.id}`).textContent = v;
      postControl({ bufferId: b.id, bufferCapacity: v });
    });
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function postControl(params, action) {
  try {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
  } catch (e) {
    console.error('control error', e);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('btn-play').addEventListener('click', () => postControl({}, 'play'));
document.getElementById('btn-pause').addEventListener('click', () => postControl({}, 'pause'));

async function applyReset(action) {
  await postControl({}, action);
  const newState = await fetch('/api/state').then(r => r.json());
  lastState = newState;
  buildPipeline();
  prevStateForDiff = newState;   // baseline; no spurious deltas next frame
  resetParticles();
  buildControlSliders(newState);
  // Sync static sliders to the post-reset state
  document.getElementById('src-interval').value = newState.source.interval;
  document.getElementById('val-src-interval').textContent = newState.source.interval;
  document.getElementById('material-stock').value = newState.source.materialStock;
  document.getElementById('val-material-stock').textContent = newState.source.materialStock;
  const m2 = newState.machines.find(m => m.id === 'M2');
  if (m2) {
    const pct = Math.round(m2.rejectRate * 100);
    document.getElementById('reject-rate').value = pct;
    document.getElementById('val-reject-rate').textContent = pct + '%';
  }
}

document.getElementById('btn-reset').addEventListener('click', () => applyReset('reset'));
document.getElementById('btn-reset-defaults').addEventListener('click', () => applyReset('resetToDefaults'));

// Export per-tick history. The browser keeps our session cookie on the
// navigation, so the server returns this session's recorded history.
function downloadExport(format) {
  const a = document.createElement('a');
  a.href = `/api/export?format=${format}`;
  a.rel  = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
document.getElementById('btn-export-csv').addEventListener('click', () => downloadExport('csv'));
document.getElementById('btn-export-json').addEventListener('click', () => downloadExport('json'));

// Speed buttons
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    postControl({ speed: parseInt(btn.dataset.speed, 10) });
  });
});

// Source controls
document.getElementById('src-interval').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('val-src-interval').textContent = v;
  postControl({ sourceInterval: v });
});

document.getElementById('material-stock').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('val-material-stock').textContent = v;
  postControl({ materialStock: v });
});

document.getElementById('reject-rate').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('val-reject-rate').textContent = v + '%';
  postControl({ machineId: 'M2', rejectRate: v / 100 });
});

// ── SSE connection ────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/events');
  let slidersBuilt = false;

  es.addEventListener('message', e => {
    const { state, metrics } = JSON.parse(e.data);
    lastState   = state;
    lastMetrics = metrics;

    // Particle flow: detect transfers between consecutive state snapshots
    const transfers = detectTransfers(prevStateForDiff, state);
    if (transfers.length > 0) spawnFromEvents(transfers);
    prevStateForDiff = state;
    particleSimState = state;
    particleSimPaused = !state.running;

    if (!slidersBuilt && state.machines) {
      buildControlSliders(state);
      slidersBuilt = true;
    }

    updatePipeline(state, metrics);
    updateMetricsDashboard(metrics, state);
  });

  es.addEventListener('error', () => {
    // Reconnect after 2 seconds on error
    es.close();
    setTimeout(connectSSE, 2000);
  });
}

// ── Machine detail panel: close handlers ─────────────────────────────────────

document.getElementById('md-close')?.addEventListener('click', closeMachineDetail);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selectedMachineId) closeMachineDetail();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

buildPipeline();
connectSSE();
