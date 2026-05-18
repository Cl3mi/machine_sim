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

    const cfg = this._config;

    this.source    = new Source(cfg.source);
    this.buffers   = cfg.buffers.map(b => new Buffer(b));
    this.machines  = cfg.machines.map(m => new Machine(m));
    this.sink      = new Sink();
    this.scrapSink = new ScrapSink();

    // Store initial config values so reset always goes back to defaults
    this._initialConfig = JSON.parse(JSON.stringify(cfg));
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
    // Process from the END of the line backwards to prevent "chain reaction"
    // where a part moves through multiple machines in one tick.
    for (let i = this.machines.length - 1; i >= 0; i--) {
      const machine = this.machines[i];
      const downstreamBuffer = this.buffers[i]; // BUF after this machine (BUF0..BUF3)
      // Note: machine index i maps to buffers[i] as downstream
      // layout: BUF0 → M1(0) → BUF1 → M2(1) → BUF2 → M3(2) → BUF3 → M4(3)

      this._advanceMachine(machine, i);
    }

    // ── STEP 2: Source emits parts ───────────────────────────────────────────
    this._tickSource();

    // ── STEP 3: Pull parts from upstream buffers into starved/idle machines ──
    // Again process from end to start so we don't cascade
    for (let i = this.machines.length - 1; i >= 0; i--) {
      const machine        = this.machines[i];
      const upstreamBuffer = this.buffers[i];    // buffer *before* this machine
      // Machines index:  0=M1, 1=M2, 2=M3, 3=M4
      // Upstream buffers: buffers[0]=BUF0 (before M1), buffers[1]=BUF1, ...

      if (machine.state === MachineState.IDLE || machine.state === MachineState.STARVED) {
        if (upstreamBuffer.parts.length > 0) {
          // Pull the oldest part from the upstream buffer
          const part = upstreamBuffer.parts.shift();
          upstreamBuffer.totalPartsOut++;

          // Accumulate the wait time this part spent in the buffer
          const waitTicks = this.tick - part._bufferEnterTick;
          upstreamBuffer.totalWaitTicks += (waitTicks > 0 ? waitTicks : 0);

          // Load the part into the machine
          part.enteredMachineAt = this.tick;
          machine.currentPart   = part;
          machine.ticksLeft     = machine.cycleTime;
          machine.state         = MachineState.PROCESSING;
        } else {
          // Nothing in buffer → starved (unless we just finished and are idle momentarily)
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

  // ── Private: advance one machine for this tick ────────────────────────────

  _advanceMachine(machine, index) {
    // Downstream buffer is buffers[index] only for M1..M3; M4 pushes to Sink
    // index 0=M1→BUF1(buffers[1]), 1=M2→BUF2(buffers[2]), 2=M3→BUF3(buffers[3]), 3=M4→SINK
    // Wait — let's re-map:
    // Pipeline: BUF0 → M1 → BUF1 → M2 → BUF2 → M3 → BUF3 → M4 → SINK
    // machine index:  0        1        2        3
    // upstream buf:   0        1        2        3
    // downstream buf: 1        2        3      (SINK for index 3)

    if (machine.state === MachineState.BLOCKED) {
      // Try to push the finished part downstream now that a slot may have opened
      this._tryPushDownstream(machine, index);
      return;
    }

    if (machine.state !== MachineState.PROCESSING) return;

    machine.ticksLeft--;

    if (machine.ticksLeft > 0) return; // still working

    // ── Processing complete ──────────────────────────────────────────────────
    machine.partsProcessed++;
    const part = machine.currentPart;

    // M2 quality gate: randomly reject parts based on rejectRate
    if (machine.rejectRate > 0 && Math.random() < machine.rejectRate) {
      // Part is scrapped
      this.scrapSink.partsReceived++;
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      // Machine is now free — it will be loaded in Step 3 if buffer has parts
      return;
    }

    // Try to push the finished part into the downstream buffer (or Sink)
    this._tryPushDownstream(machine, index);
  }

  _tryPushDownstream(machine, index) {
    const part = machine.currentPart;

    if (index === this.machines.length - 1) {
      // Last machine (M4) → push to Sink
      part.completedAt = this.tick;
      this.sink.partsReceived++;
      this.sink.completedParts.push(part);
      // Trim to last 200 to prevent unbounded growth
      if (this.sink.completedParts.length > 200) {
        this.sink.completedParts.shift();
      }
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
    } else {
      // Push to downstream buffer (index+1)
      const downstreamBuffer = this.buffers[index + 1];
      if (downstreamBuffer.parts.length < downstreamBuffer.capacity) {
        // Buffer has space — push the part
        part._bufferEnterTick = this.tick;
        downstreamBuffer.parts.push(part);
        machine.currentPart = null;
        machine.state       = MachineState.IDLE;
      } else {
        // Buffer full → machine is BLOCKED
        // The part stays in the machine until space opens up.
        // This back-pressure propagates upstream (starving earlier machines).
        machine.state = MachineState.BLOCKED;
      }
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
