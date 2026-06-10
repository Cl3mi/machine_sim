import { WebSocketServer } from 'ws';
import net from 'net';

export function attachOpcUaBridge(httpServer, tcpPort) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has('opcua+uabinary') ? 'opcua+uabinary' : false,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/opcua') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    const tcp = net.connect(tcpPort, '127.0.0.1');
    let buf = Buffer.alloc(0);

    // OPC-UA binary frame: 3-byte type + 1-byte chunk flag + 4-byte UInt32LE total length
    // Buffer TCP stream until we have a complete message, then send as one WS frame.
    tcp.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const msgLen = buf.readUInt32LE(4);
        if (buf.length < msgLen) break;
        if (ws.readyState === ws.OPEN) ws.send(buf.slice(0, msgLen));
        buf = buf.slice(msgLen);
      }
    });

    // WS→TCP: each WS frame is already one complete OPC-UA message
    ws.on('message', (data) => tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));

    tcp.on('error', () => { if (ws.readyState !== ws.CLOSED) ws.terminate(); });
    tcp.on('close', () => { if (ws.readyState !== ws.CLOSED) ws.terminate(); });
    ws.on('error', () => tcp.destroy());
    ws.on('close', () => tcp.destroy());
  });
}
