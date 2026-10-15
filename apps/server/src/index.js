import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createPool } from '@ama/db';
import { createApp } from './app.js';
import { authenticateSocket } from './auth.js';
import { startEventPoller, emitterFor } from './realtime.js';

const PORT = Number(process.env.AMA_PORT ?? 3001);
const allowedOrigin = process.env.AMA_WEB_ORIGIN ?? 'http://localhost:5173';

const pool = createPool();
const app = createApp({ pool, allowedOrigin });
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, credentials: true },
});
io.use(authenticateSocket);
io.on('connection', (socket) => {
  // Reconnect: klien wajib mengambil ulang snapshot REST; server tidak memutar ulang event.
  socket.emit('connected', { at: new Date().toISOString() });
});

const poller = startEventPoller({ pool, emit: emitterFor(io) });

httpServer.listen(PORT, () => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'server_started', port: PORT })}\n`);
});

async function shutdown() {
  poller.stop();
  io.close();
  httpServer.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
