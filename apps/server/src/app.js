import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth, verifyCredentials, issueToken, clearToken } from './auth.js';
import {
  listDevices,
  getDevice,
  getMetrics,
  listAlerts,
  listAlertCenter,
  alertSummary,
  getAlert,
  ackAlert,
  resolveAlert,
  parseAlertQuery,
  getHealth,
  parseRange,
  parseSummaryRange,
  summarySeries,
  createDevice,
  updateDevice,
  deleteDevice,
  deviceExists,
  deviceHasHistory,
  ipTaken,
  markSecretUpdated,
  clearSecretUpdated,
  insertDeviceAction,
  lastSentActionAt,
  listDeviceActions,
} from './queries.js';
import { parseDeviceInput, parseProbeInput } from './device-input.js';
import { hasSecret as hasStoredSecret, readAll as readSecrets, setSecret, removeSecret } from './secrets-file.js';
import { probeHostKey } from './ssh-probe.js';
import { listClients } from './ssh-clients.js';
import { runDeviceAction, ACTIONS } from './ssh-action.js';
import { log } from './logger.js';

function isInt(value) {
  return /^\d+$/.test(String(value));
}

// Pelanggaran indeks unik ip (balapan dengan pre-check) tetap dilaporkan sebagai 409.
function isDuplicateKey(err) {
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

function emptySeries(buckets) {
  return { latency: new Array(buckets).fill(null), ram: new Array(buckets).fill(null) };
}

export function createApp({ pool, allowedOrigin, probe = probeHostKey, clients = listClients, action = runDeviceAction }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  // Origin dibatasi; kredensial cookie perlu origin eksplisit, bukan '*'.
  app.use((req, res, next) => {
    if (allowedOrigin && req.headers.origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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

  // Didaftarkan sebelum rute :id supaya 'probe' tidak pernah dibaca sebagai id.
  app.post('/api/devices/probe', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseProbeInput(req.body ?? {});
      if (!parsed.ok) return res.status(400).json({ error: 'invalid_payload', fields: parsed.fields });
      const result = await probe(parsed.value);
      if (!result.ok) return res.status(502).json({ error: 'probe_failed', code: result.code });
      return res.json({ fingerprint: result.fingerprint });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/devices', requireAuth, async (req, res, next) => {
    try {
      res.json({ devices: await listDevices(pool, hasStoredSecret) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/devices', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseDeviceInput(req.body ?? {});
      if (!parsed.ok) return res.status(400).json({ error: 'invalid_payload', fields: parsed.fields });
      const { fields, password } = parsed.value;
      if (await ipTaken(pool, fields.ip)) return res.status(409).json({ error: 'ip_taken' });

      const id = await createDevice(pool, fields);
      log.info({ event: 'device_created', deviceId: id, user: req.user });
      if (password !== null) {
        setSecret(id, password);
        await markSecretUpdated(pool, id);
        log.info({ event: 'device_secret_set', deviceId: id, user: req.user });
      }
      return res.status(201).json({ device: await getDevice(pool, id, hasStoredSecret) });
    } catch (err) {
      if (isDuplicateKey(err)) return res.status(409).json({ error: 'ip_taken' });
      return next(err);
    }
  });

  app.get('/api/summary', requireAuth, async (req, res, next) => {
    try {
      const range = parseSummaryRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const devices = await listDevices(pool, hasStoredSecret);
      const series = await summarySeries(pool, range);

      // stale = data sistem perangkat sudah lewat ambang kesegaran.
      const counts = { total: devices.length, up: 0, down: 0, unknown: 0, stale: 0 };
      for (const device of devices) {
        if (device.reachable === 'up') counts.up += 1;
        else if (device.reachable === 'down') counts.down += 1;
        else counts.unknown += 1;
        if (device.freshness.system === 'stale') counts.stale += 1;
      }

      return res.json({
        from: range.from,
        to: range.to,
        bucket_ms: range.bucket_ms,
        counts,
        devices: devices.map((device) => ({
          ...device,
          series: series[String(device.id)] ?? emptySeries(range.buckets),
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/devices/:id', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const device = await getDevice(pool, Number(req.params.id), hasStoredSecret);
      if (!device) return res.status(404).json({ error: 'not_found' });
      return res.json(device);
    } catch (err) {
      return next(err);
    }
  });

  app.patch('/api/devices/:id', requireAuth, async (req, res, next) => {
    try {
      // Id non-numerik tidak pernah ada → 404, bukan 400.
      if (!isInt(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const parsed = parseDeviceInput(req.body ?? {}, { partial: true });
      if (!parsed.ok) return res.status(400).json({ error: 'invalid_payload', fields: parsed.fields });

      const id = Number(req.params.id);
      const { fields, password } = parsed.value;
      if (fields.ip !== undefined && (await ipTaken(pool, fields.ip, id))) {
        return res.status(409).json({ error: 'ip_taken' });
      }
      if (!(await deviceExists(pool, id))) return res.status(404).json({ error: 'not_found' });

      await updateDevice(pool, id, fields);
      log.info({ event: 'device_updated', deviceId: id, user: req.user });
      if (password !== null) {
        setSecret(id, password);
        await markSecretUpdated(pool, id);
        log.info({ event: 'device_secret_set', deviceId: id, user: req.user });
      }
      return res.json({ device: await getDevice(pool, id, hasStoredSecret) });
    } catch (err) {
      if (isDuplicateKey(err)) return res.status(409).json({ error: 'ip_taken' });
      return next(err);
    }
  });

  app.delete('/api/devices/:id', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const id = Number(req.params.id);
      if (!(await deviceExists(pool, id))) return res.status(404).json({ error: 'not_found' });
      // Muncul di histori → jangan hapus apa pun.
      if (await deviceHasHistory(pool, id)) return res.status(409).json({ error: 'device_has_history' });

      await deleteDevice(pool, id);
      removeSecret(id);
      log.info({ event: 'device_deleted', deviceId: id, user: req.user });
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  app.delete('/api/devices/:id/secret', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const id = Number(req.params.id);
      if (!(await deviceExists(pool, id))) return res.status(404).json({ error: 'not_found' });

      removeSecret(id);
      await clearSecretUpdated(pool, id);
      log.info({ event: 'device_secret_removed', deviceId: id, user: req.user });
      return res.status(204).end();
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
      const device = await getDevice(pool, Number(req.params.id), hasStoredSecret);
      if (!device) return res.status(404).json({ error: 'not_found' });
      const metrics = await getMetrics(pool, Number(req.params.id), range, kind);
      return res.json({ device_id: Number(req.params.id), from: range.from, to: range.to, metrics });
    } catch (err) {
      return next(err);
    }
  });

  // Daftar client live: SSH sesaat ke AP dengan host key tersemat. Tidak disimpan ke DB.
  app.get('/api/devices/:id/clients', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const id = Number(req.params.id);
      const device = await getDevice(pool, id, hasStoredSecret);
      if (!device) return res.status(404).json({ error: 'not_found' });
      const password = readSecrets()[String(id)];
      if (typeof password !== 'string' || password === '') return res.status(409).json({ error: 'no_secret' });

      const result = await clients({
        ip: device.ip,
        port: device.port ?? 22,
        username: device.username,
        password,
        hostKeyFingerprint: device.host_key_fingerprint,
      });
      if (!result.ok) {
        log.info({ event: 'clients_failed', deviceId: id, code: result.code });
        return res.status(502).json({ error: 'clients_failed', code: result.code });
      }
      return res.json({
        observed_at: result.observedAt,
        total: result.total,
        truncated: result.truncated,
        clients: result.clients,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Aksi kontrol AP (reboot) lewat SSH sesaat. Perintah dari whitelist ACTIONS,
  // tidak pernah dari masukan pengguna. ponytail: satu akun operator tanpa role
  // per aksi; tambahkan daftar pengguna + role bila dashboard dipakai banyak orang.
  const CONTROL_ENABLED = () => process.env.AMA_CONTROL_ENABLED === 'true';
  const ACTION_COOLDOWN_MS = 5 * 60 * 1000;

  app.get('/api/devices/:id/actions', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: 'invalid_limit' });
      }
      const id = Number(req.params.id);
      if (!(await deviceExists(pool, id))) return res.status(404).json({ error: 'not_found' });
      return res.json({ control_enabled: CONTROL_ENABLED(), actions: await listDeviceActions(pool, id, limit) });
    } catch (err) {
      return next(err);
    }
  });

  // Konfirmasi wajib: body harus memuat nama perangkat persis seperti yang tampil di UI.
  app.post('/api/devices/:id/actions', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      if (!CONTROL_ENABLED()) return res.status(403).json({ error: 'control_disabled' });

      const { action: requested, confirm } = req.body ?? {};
      if (typeof requested !== 'string' || !Object.hasOwn(ACTIONS, requested)) {
        return res.status(400).json({ error: 'invalid_payload', fields: { action: 'unknown_action' } });
      }

      const id = Number(req.params.id);
      const device = await getDevice(pool, id, hasStoredSecret);
      if (!device) return res.status(404).json({ error: 'not_found' });
      if (typeof confirm !== 'string' || confirm !== device.name) {
        return res.status(400).json({ error: 'invalid_payload', fields: { confirm: 'confirm_mismatch' } });
      }

      const password = readSecrets()[String(id)];
      if (typeof password !== 'string' || password === '') return res.status(409).json({ error: 'no_secret' });

      const last = await lastSentActionAt(pool, id, requested);
      const nextAllowed = last ? Date.parse(last) + ACTION_COOLDOWN_MS : 0;
      if (last && Date.now() < nextAllowed) {
        return res.status(429).json({ error: 'cooldown', next_allowed_at: new Date(nextAllowed).toISOString() });
      }

      const result = await action(
        {
          ip: device.ip,
          port: device.port ?? 22,
          username: device.username,
          password,
          hostKeyFingerprint: device.host_key_fingerprint,
        },
        requested,
      );
      const status = result.ok ? 'sent' : 'failed';
      const at = new Date();
      await insertDeviceAction(pool, { deviceId: id, action: requested, user: req.user, status, errorCode: result.code ?? null, at });
      log.info({ event: 'device_action', deviceId: id, action: requested, user: req.user, status, code: result.code ?? null });

      if (!result.ok) return res.status(502).json({ error: 'action_failed', code: result.code });
      return res.json({ ok: true, action: requested, status, requested_at: at.toISOString() });
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

  // --- Alert Center §8: /summary dan /:id didaftarkan sebelum rute generik. ------
  app.get('/api/alerts/summary', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseAlertQuery(req.query);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      return res.json(await alertSummary(pool, parsed.period));
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/alert-center', requireAuth, async (req, res, next) => {
    try {
      const parsed = parseAlertQuery(req.query);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const alerts = await listAlertCenter(pool, parsed);
      return res.json({ alerts, limit: parsed.limit, offset: parsed.offset });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/alerts/:id', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const detail = await getAlert(pool, Number(req.params.id));
      if (!detail) return res.status(404).json({ error: 'not_found' });
      return res.json(detail);
    } catch (err) {
      return next(err);
    }
  });

  // Acknowledge mencatat pengguna + waktu; tidak pernah menyelesaikan insiden.
  app.post('/api/alerts/:id/ack', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const result = await ackAlert(pool, { id: Number(req.params.id), user: req.user });
      if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
      if (result.error === 'already_resolved') return res.status(409).json({ error: 'already_resolved' });
      log.info({ event: 'alert_acknowledged', deviceId: result.id, user: req.user, status: result.status });
      return res.json({ id: result.id, status: result.status, acknowledged_at: result.at, acknowledged_by: req.user, unchanged: Boolean(result.unchanged) });
    } catch (err) {
      return next(err);
    }
  });

  // Resolve manual dicatat sebagai aksi operator; auto-resolve rule tetap berlaku.
  app.post('/api/alerts/:id/resolve', requireAuth, async (req, res, next) => {
    try {
      if (!isInt(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
      const result = await resolveAlert(pool, { id: Number(req.params.id), user: req.user });
      if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
      if (result.error === 'already_resolved') return res.status(409).json({ error: 'already_resolved' });
      log.info({ event: 'alert_resolved', deviceId: result.id, user: req.user, status: result.status });
      return res.json({ id: result.id, status: result.status, resolved_at: result.at, resolved_by: req.user, unchanged: Boolean(result.unchanged) });
    } catch (err) {
      return next(err);
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
