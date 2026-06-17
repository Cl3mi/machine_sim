/**
 * engine.js
 * Core discrete-event tick loop for the PlantSim teaching simulation.
 *
 * Architecture:
 *   - Each "tick" advances the simulation clock by 1 unit of simulated time.
 *   - Processing order within a tick: advance machines → pull/push parts → update states.
 *   - We process from the END of the line to the START each tick. This prevents
 *     a part from moving through multiple stations in a single tick (the "domino effect"
 *     that would make a short line appear to have infinite throughput).
 *
 * PlantSim concept mapping:
 *   - tick loop           → SimEvent / Simulation.run()
 *   - Machine.state       → Object attribute / EventController
 *   - Buffer              → Store / Queue object
 *   - BLOCKED logic       → "BackPressure" / cannot-enter condition
 *   - STARVED logic       → "NoPart" / cannot-start condition
 */

import EventEmitter from 'events';
import { Part, Source, Buffer, Machine, Sink, ScrapSink, MachineState } from './entities.js';
import { DEFAULT_CONFIG } from './config.js';

export class SimulationEngine extends EventEmitter {
  constructor(config = DEFAULT_CONFIG) {
    super();
    this._config = JSON.parse(JSON.stringify(config)); // deep clone so mutations don't bleed
    this._reset();

    this._running     = false;
    this._intervalRef = null;
    this._speed       = 1;          // wall-clock speed multiplier (1×, 2×, 5×, 10×)
    this._nextPartId  = 1;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  play() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext();
  }

  pause() {
    this._running = false;
    if (this._intervalRef) {
      clearTimeout(this._intervalRef);
      this._intervalRef = null;
    }
  }

  setSpeed(multiplier) {
    // Valid multipliers: 1, 2, 5, 10
    this._speed = multiplier;
    if (this._running) {
      // Restart the tick loop at the new rate
      clearTimeout(this._intervalRef);
      this._scheduleNext();
    }
  }

  // Resets state but keeps user-adjusted config values (cycle times, capacities, etc.)
  // Does not auto-start; call play() explicitly.
  reset() {
    this.pause();
    this._nextPartId = 1;
    this._reset();
  }

  // Resets state AND restores all config values to DEFAULT_CONFIG.
  // Does not auto-start; call play() explicitly.
  resetToDefaults() {
    this.pause();
    this._nextPartId = 1;
    this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this._reset();
  }

  // Live config update — students can change parameters while the sim runs.
  // Also mirrors changes into _config so that reset() preserves them.
  updateConfig(params) {
    if (params.speed !== undefined) this.setSpeed(params.speed);

    if (params.sourceInterval !== undefined) {
      this.source.interval = params.sourceInterval;
      this._config.source.interval = params.sourceInterval;
    }
    if (params.materialStock !== undefined) {
      this.source.materialStock = params.materialStock;
      this._config.source.materialStock = params.materialStock;
    }

    if (params.machineId !== undefined) {
      const m = this.machines.find(m => m.id === params.machineId);
      if (m) {
        if (params.cycleTime !== undefined) {
          m.cycleTime = params.cycleTime;
          const cfgM = this._config.machines.find(cm => cm.id === params.machineId);
          if (cfgM) cfgM.cycleTime = params.cycleTime;
        }
        if (params.rejectRate !== undefined) {
          m.rejectRate = params.rejectRate;
          const cfgM = this._config.machines.find(cm => cm.id === params.machineId);
          if (cfgM) cfgM.rejectRate = params.rejectRate;
        }
      }
    }

    if (params.bufferId !== undefined) {
      const b = this.buffers.find(b => b.id === params.bufferId);
      if (b && params.bufferCapacity !== undefined) {
        b.capacity = params.bufferCapacity;
        const cfgB = this._config.buffers.find(cb => cb.id === params.bufferId);
        if (cfgB) cfgB.capacity = params.bufferCapacity;
        // If parts now exceed new capacity, leave them in (don't eject — too disruptive)
      }
    }
  }

  // Returns the per-tick history recorded since the last reset.
  // Each entry is a flat object — one row per simulated tick — suitable for
  // direct CSV/JSON export.
  getHistory() {
    return this._history;
  }

  // Returns a plain JSON-serialisable snapshot of the current state
  getState() {
    return {
      tick:     this.tick,
      running:  this._running,
      speed:    this._speed,
      source: {
        id:            this.source.id,
        interval:      this.source.interval,
        materialStock: this.source.materialStock,
        totalGenerated: this.source.totalGenerated,
        lastEmitted:   this.source.lastEmitted,
        ticksSinceLast: this.source.ticksSinceLast,
      },
      machines: this.machines.map(m => ({
        id:              m.id,
        stationId:       m.stationId,
        inputBufferId:   m.inputBufferId,
        outputBufferId:  m.outputBufferId,
        name:            m.name,
        cycleTime:       m.cycleTime,
        rejectRate:      m.rejectRate,
        state:           m.state,
        ticksLeft:       m.ticksLeft,
        ticksProcessing: m.ticksProcessing,
        ticksBlocked:    m.ticksBlocked,
        ticksStarved:    m.ticksStarved,
        ticksIdle:       m.ticksIdle,
        partsProcessed:  m.partsProcessed,
        currentPartId:   m.currentPart?.id ?? null,
      })),
      buffers: this.buffers.map(b => ({
        id:           b.id,
        capacity:     b.capacity,
        load:         b.parts.length,
        partIds:      b.parts.map(p => p.id),
        totalWaitTicks: b.totalWaitTicks,
        totalPartsOut:  b.totalPartsOut,
      })),
      sink: {
        partsReceived: this.sink.partsReceived,
        // Last 20 completed parts for lead-time calculation
        recentParts: this.sink.completedParts.slice(-20).map(p => ({
          id: p.id, createdAt: p.createdAt, completedAt: p.completedAt,
        })),
      },
      scrap: {
        partsReceived: this.scrapSink.partsReceived,
      },
    };
  }

  // ── Private: initialise/reset all simulation objects ─────────────────────

  _reset() {
    this.tick = 0;
    this._history = [];

    const cfg = this._config;

    this.source    = new Source(cfg.source);
    this.buffers   = cfg.buffers.map(b => new Buffer(b));
    this.machines  = cfg.machines.map(m => new Machine(m));
    this.sink      = new Sink();
    this.scrapSink = new ScrapSink();

    this._reindex();

    // Store initial config values so reset always goes back to defaults
    this._initialConfig = JSON.parse(JSON.stringify(cfg));
  }

  // Rebuild the buffer lookup and station ordering. Call whenever the set of
  // machines or buffers changes (reset, spawn, remove).
  _reindex() {
    this._bufferById = new Map(this.buffers.map(b => [b.id, b]));
    this._assignStationOrder();
  }

  // Walk the buffer graph from the source-fed buffer (the one no machine
  // produces) and assign each station an increasing `order`. Machines sharing a
  // stationId share an order. Used to process downstream→upstream each tick.
  _assignStationOrder() {
    const produced = new Set(
      this.machines.map(m => m.outputBufferId).filter(id => id != null)
    );
    let curId = this.buffers.find(b => !produced.has(b.id))?.id
              ?? this.buffers[0]?.id;

    const stationOrder = new Map();   // stationId -> order
    let order = 0;
    const seen = new Set();
    while (curId != null && !seen.has(curId)) {
      seen.add(curId);
      const here = this.machines.filter(m => m.inputBufferId === curId);
      if (here.length === 0) break;
      const stationId = here[0].stationId;
      if (!stationOrder.has(stationId)) stationOrder.set(stationId, order++);
      curId = here[0].outputBufferId;   // parallel machines share output
    }
    for (const m of this.machines) {
      m._order = stationOrder.get(m.stationId) ?? 0;
    }
    // Machines processed end→start: highest order first.
    this._processOrder = [...this.machines].sort((a, b) => b._order - a._order);
  }

  // ── Private: tick scheduling ───────────────────────────────────────────────

  _scheduleNext() {
    if (!this._running) return;
    const msPerTick = 1000 / (this._config.ticksPerSecond * this._speed);
    this._intervalRef = setTimeout(() => {
      this._tick();
      this._scheduleNext();
    }, msPerTick);
  }

  // ── Private: one simulation tick ──────────────────────────────────────────

  _tick() {
    this.tick++;

    // Reset "just emitted" flag from previous tick
    this.source.lastEmitted = false;

    // ── STEP 1: Advance machines (count down processing timers) ─────────────
    // Process downstream→upstream (highest station order first) to prevent a
    // part cascading through multiple machines in one tick.
    for (const machine of this._processOrder) {
      this._advanceMachine(machine);
    }

    // ── STEP 2: Source emits parts ───────────────────────────────────────────
    this._tickSource();

    // ── STEP 3: Pull parts from each machine's input buffer ──────────────────
    for (const machine of this._processOrder) {
      if (machine.state === MachineState.IDLE || machine.state === MachineState.STARVED) {
        const upstreamBuffer = this._bufferById.get(machine.inputBufferId);
        if (upstreamBuffer && upstreamBuffer.parts.length > 0) {
          const part = upstreamBuffer.parts.shift();
          upstreamBuffer.totalPartsOut++;

          const waitTicks = this.tick - part._bufferEnterTick;
          upstreamBuffer.totalWaitTicks += (waitTicks > 0 ? waitTicks : 0);

          part.enteredMachineAt = this.tick;
          machine.currentPart   = part;
          machine.ticksLeft     = machine.cycleTime;
          machine.state         = MachineState.PROCESSING;
        } else {
          machine.state = MachineState.STARVED;
        }
      }
    }

    // ── STEP 4: Accumulate state-time counters ───────────────────────────────
    for (const m of this.machines) {
      switch (m.state) {
        case MachineState.PROCESSING: m.ticksProcessing++; break;
        case MachineState.BLOCKED:    m.ticksBlocked++;    break;
        case MachineState.STARVED:    m.ticksStarved++;    break;
        case MachineState.IDLE:       m.ticksIdle++;       break;
      }
    }

    this._recordHistory();

    this.emit('tick', this.getState());

    // ── STEP 5: Auto-pause when all materials are done ───────────────────────
    // Conditions: source exhausted + no parts in any buffer + no machine holds a part
    if (this.source.materialStock === 0) {
      const noPipelineParts =
        this.buffers.every(b => b.parts.length === 0) &&
        this.machines.every(m => m.currentPart === null);

      if (noPipelineParts) {
        this.pause();
        this.emit('simulation-complete', this.getState());
      }
    }
  }

  // ── Private: append a flat snapshot for this tick to the history buffer ───
  //
  // Rolling cap of 100k rows keeps long infinite-stock runs from leaking
  // unbounded memory; the oldest tick is dropped once the cap is hit.

  _recordHistory() {
    const row = {
      tick: this.tick,
      sourceTotalGenerated: this.source.totalGenerated,
      sourceMaterialStock:  this.source.materialStock,
    };

    for (const m of this.machines) {
      const id = m.id;
      row[`${id}_state`]            = m.state;
      row[`${id}_partsProcessed`]   = m.partsProcessed;
      row[`${id}_ticksProcessing`]  = m.ticksProcessing;
      row[`${id}_ticksBlocked`]     = m.ticksBlocked;
      row[`${id}_ticksStarved`]     = m.ticksStarved;
      row[`${id}_ticksIdle`]        = m.ticksIdle;
      row[`${id}_currentPartId`]    = m.currentPart?.id ?? '';
    }

    for (const b of this.buffers) {
      row[`${b.id}_load`]     = b.parts.length;
      row[`${b.id}_capacity`] = b.capacity;
    }

    row.sinkPartsReceived  = this.sink.partsReceived;
    row.scrapPartsReceived = this.scrapSink.partsReceived;

    this._history.push(row);
    if (this._history.length > 100_000) this._history.shift();
  }

  // ── Private: advance one machine for this tick ────────────────────────────

  _advanceMachine(machine) {
    if (machine.state === MachineState.BLOCKED) {
      this._tryPushDownstream(machine);
      return;
    }

    if (machine.state !== MachineState.PROCESSING) return;

    machine.ticksLeft--;
    if (machine.ticksLeft > 0) return; // still working

    machine.partsProcessed++;

    // Quality gate: randomly reject parts based on rejectRate
    if (machine.rejectRate > 0 && Math.random() < machine.rejectRate) {
      this.scrapSink.partsReceived++;
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    this._tryPushDownstream(machine);
  }

  _tryPushDownstream(machine) {
    const part = machine.currentPart;

    if (machine.outputBufferId == null) {
      // Pushes to the Sink
      part.completedAt = this.tick;
      this.sink.partsReceived++;
      this.sink.completedParts.push(part);
      if (this.sink.completedParts.length > 200) this.sink.completedParts.shift();
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    const downstreamBuffer = this._bufferById.get(machine.outputBufferId);
    if (downstreamBuffer && downstreamBuffer.parts.length < downstreamBuffer.capacity) {
      part._bufferEnterTick = this.tick;
      downstreamBuffer.parts.push(part);
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
    } else {
      // Buffer full → BLOCKED (back-pressure propagates upstream)
      machine.state = MachineState.BLOCKED;
    }
  }

  // ── Private: source tick ──────────────────────────────────────────────────

  _tickSource() {
    // Material starvation check: -1 means infinite stock; 0 means depleted
    if (this.source.materialStock === 0) return; // stock depleted, no more parts

    this.source.ticksSinceLast++;

    if (this.source.ticksSinceLast < this.source.interval) return;

    // Enough ticks elapsed — try to emit a part into BUF0
    const buf0 = this.buffers[0];
    if (buf0.parts.length >= buf0.capacity) return; // BUF0 full, can't emit

    // Emit a new part
    const part = new Part(this._nextPartId++, this.tick);
    part._bufferEnterTick = this.tick;
    buf0.parts.push(part);

    this.source.ticksSinceLast  = 0;
    this.source.totalGenerated++;
    this.source.lastEmitted     = true;

    // Decrement material stock; -1 means infinite (no decrement)
    if (this.source.materialStock > 0) {
      this.source.materialStock--;
    }
  }
}
