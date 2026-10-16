import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth, verifyCredentials, issueToken, clearToken } from './auth.js';
import {
  listDevices,
  getDevice,
  getMetrics,
  listAlerts,
  getHealth,
  parseRange,
} from './queries.js';

function isInt(value) {
  return /^\d+$/.test(String(value));
}

export function createApp({ pool, allowedOrigin }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  // Origin dibatasi; kredensial cookie perlu origin eksplisit, bukan '*'.
  app.use((req, res, next) => {
    if (allowedOrigin && req.headers.origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!verifyCredentials(username, password)) {
      // Pesan generik, tanpa membocorkan bagian mana yang salah.
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    issueToken(res, username);
    return res.json({ ok: true, user: username });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearToken(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // Health tanpa autentikasi untuk probe; tidak memuat rahasia.
  app.get('/api/health', async (req, res) => {
    const health = await getHealth(pool);
    res.status(health.ok ? 200 : 503).json(health);
  });

  app.get('/api/devices', requireAuth, async (req, res, next) => {
    try {
      res.json({ devices: await listDevices(pool) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/devices/:id', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const device = await getDevice(pool, Number(req.params.id));
      if (!device) return res.status(404).json({ error: 'not_found' });
      return res.json(device);
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/devices/:id/metrics', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const range = parseRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const kind = req.query.kind;
      if (kind && kind !== 'ping' && kind !== 'system') {
        return res.status(400).json({ error: 'invalid_kind' });
      }
      const device = await getDevice(pool, Number(req.params.id));
      if (!device) return res.status(404).json({ error: 'not_found' });
      const metrics = await getMetrics(pool, Number(req.params.id), range, kind);
      return res.json({ device_id: Number(req.params.id), from: range.from, to: range.to, metrics });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/alerts', requireAuth, async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return res.status(400).json({ error: 'invalid_limit' });
      }
      res.json({ alerts: await listAlerts(pool, limit) });
    } catch (err) {
      next(err);
    }
  });

  // Error handler: log aman, respons generik.
  app.use((err, req, res, _next) => {
    process.stderr.write(`${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'api_error',
      method: req.method,
      path: req.path,
      code: err?.code ?? err?.name ?? 'unknown',
      message: err?.message ?? '',
    })}\n`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
