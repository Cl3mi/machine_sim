# OPC-UA WebSocket Integration Design

**Date:** 2026-06-10
**Status:** Approved

## Summary

Add an OPC-UA server (WebSocket transport, UA/WS) to the PlantSim PoC so external industrial clients (UA Expert, etc.) can browse and subscribe to live machine/buffer state. Caddy reverse-proxies the WebSocket connection — no TCP port exposed publicly, no Caddy plugins required.

## Architecture

```
UA Expert / OPC-UA client
        |
  opc.wss://yourdomain.com/opcua
        |
     Caddy (TLS termination, WS upgrade)
        |
  ws://localhost:4843   ← OPC-UA WS server
        |
  SimulationEngine (shared instance)
        |
  Fastify HTTP :3000
```

A new module `src/opcua/server.js` creates and starts the OPC-UA server. It receives the `SimulationEngine` instance and registers a `postTick` callback on the engine to push updated `DataValue`s into the OPC-UA address space each tick. `src/server.js` imports and starts both servers.

## Address Space

```
Objects/
  PlantSim/
    Machines/
      M1/  state, cycleTime, partsProcessed, ticksProcessing, ticksBlocked
      M2/  state, cycleTime, partsProcessed, ticksProcessing, ticksBlocked, rejectRate
      M3/  state, cycleTime, partsProcessed, ticksProcessing, ticksBlocked
      M4/  state, cycleTime, partsProcessed, ticksProcessing, ticksBlocked
    Buffers/
      BUF0/  currentParts, capacity
      BUF1/  currentParts, capacity
      BUF2/  currentParts, capacity
      BUF3/  currentParts, capacity
    Simulation/
      tick, running, throughput, bottleneckId
```

All variables are `Float` or `String` as appropriate. `state` is a `String` (IDLE/PROCESSING/BLOCKED/STARVED). Values are written on every engine tick via the engine's `postTick` callback hook.

## Engine Coupling

`SimulationEngine` already extends `EventEmitter` and emits `'tick'` with the state snapshot at the end of every `_tick()`. No engine changes needed:

```js
engine.on('tick', (state) => { /* write OPC-UA node values */ });
```

No polling interval needed — updates are driven by the simulation clock.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPCUA_WS_PORT` | `4843` | Internal WS listen port |
| `OPCUA_ENDPOINT_URL` | `opc.wss://localhost/opcua` | Announced endpoint URL (must match public Caddy URL) |

`OPCUA_ENDPOINT_URL` must be set to the real public URL so OPC-UA clients can reconnect after session handshake.

## Docker Changes

`Dockerfile`: add `EXPOSE 4843`

`docker-compose.yml`: add env vars:
```yaml
environment:
  - PORT=3000
  - OPCUA_WS_PORT=4843
  - OPCUA_ENDPOINT_URL=opc.wss://yourdomain.com/opcua
```

Port 4843 is NOT mapped to the host (stays internal). Caddy on the host reaches it via `localhost:4843` (network_mode: host is already in use).

## Caddy Config

Add inside the existing site block:

```
handle /opcua* {
    reverse_proxy localhost:4843
}
```

## Security

OPC-UA security mode: `None`. TLS is handled at the Caddy layer (HTTPS/WSS). Acceptable for a prototype showcase; not for production.

## Dependencies

Add to `package.json`:
```
"node-opcua": "^2.120.0"
```

`node-opcua` is a single package that includes the server, address space builder, and WebSocket transport. No additional packages needed.

## Files Touched

| File | Change |
|---|---|
| `package.json` | add `node-opcua` dependency |
| `src/opcua/server.js` | new — OPC-UA server, address space, tick hook |
| `src/server.js` | import and start OPC-UA server after engine init |
| `Dockerfile` | add `EXPOSE 4843` |
| `docker-compose.yml` | add `OPCUA_WS_PORT`, `OPCUA_ENDPOINT_URL` env vars |
| `Caddyfile` (user-managed) | add `handle /opcua*` block |
