/**
 * controls.js
 * Thin wrappers around SimulationEngine control methods.
 * Imported by both HTTP control routes and OPC UA Methods so both
 * surfaces drive the engine identically.
 */

export function play(engine) {
  engine.play();
}

export function pause(engine) {
  engine.pause();
}

export function reset(engine) {
  engine.reset();
}

export function setSpeed(engine, multiplier) {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('speed multiplier must be a positive finite number');
  }
  engine.setSpeed(multiplier);
}
