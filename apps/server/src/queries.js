// Query terparameter, tanpa penyambungan string masukan §7.
import { HISTORY, STALE_MS } from '@ama/shared';

// Rentang /api/summary: tetapkan bucket tetap agar seri maksimum 60 titik.
export const SUMMARY_RANGES = {
  '1h': { rangeMs: 60 * 60 * 1000, bucketMs: 60 * 1000 },
  '6h': { rangeMs: 6 * 60 * 60 * 1000, bucketMs: 6 * 60 * 1000 },
  '24h': { rangeMs: 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 1000 },
};

// Kolom device yang boleh ditulis dari payload tulis.
const DEVICE_COLUMNS = [
  'name',
  'ip',
  'port',
  'username',
  'vendor',
  'model',
  'firmware',
  'host_key_fingerprint',
  'notes',
  'enabled',
];

function freshness(lastValidAt, nowMs, thresholdMs) {
  if (!lastValidAt) return 'no_data';
  const age = nowMs - new Date(lastValidAt).getTime();
  return age > thresholdMs ? 'stale' : 'fresh';
}

function lastValidOf(rows, field) {
  for (const row of rows) {
    if (row.metric_status && row.metric_status[field]?.status === 'ok') {
      return { value: row[field], last_valid_at: row.observed_at };
    }
  }
  return { value: null, last_valid_at: null };
}

// Semua nilai waktu ke respons adalah ISO UTC.
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sqlTime(iso) {
  return iso.replace('T', ' ').replace('Z', '');
}

// `hasSecret` disuntikkan dari app.js (fungsi berkas rahasia) supaya queries.js
// tetap murni DB: stub pool di uji tidak perlu ikut menyentuh berkas/env.
export async function listDevices(pool, hasSecret = () => false) {
  const devices = await pool.query(
    `SELECT id, name, ip, port, username, vendor, model, firmware,
            host_key_fingerprint, identity_verified, enabled, notes, secret_updated_at,
            reachable, ping_fail_count, ping_ok_count, last_ping_attempt_at,
            uptime_last_valid_at, load_last_valid_at, ram_last_valid_at,
            system_last_valid_at, last_collection_status
     FROM devices ORDER BY name`,
  );

  const now = Date.now();
  const result = [];
  for (const device of devices) {
    const lastSystem = await pool.query(
      `SELECT observed_at, collection_status, uptime_seconds, load_1, load_5, load_15,
              memory_total_bytes, memory_available_bytes, memory_used_bytes, memory_used_percent,
              metric_status
       FROM device_metrics
       WHERE device_id = ? AND kind = 'system'
       ORDER BY observed_at DESC LIMIT 1`,
      [device.id],
    );
    const lastPing = await pool.query(
      `SELECT observed_at, reachable, latency_ms FROM device_metrics
       WHERE device_id = ? AND kind = 'ping' ORDER BY observed_at DESC LIMIT 1`,
      [device.id],
    );
    const row = lastSystem[0];
    const metrics = row
      ? {
          uptime_seconds: lastValidOf([row], 'uptime_seconds'),
          load_1: lastValidOf([row], 'load_1'),
          memory_used_percent: lastValidOf([row], 'memory_used_percent'),
        }
      : null;

    result.push({
      id: device.id,
      name: device.name,
      ip: device.ip,
      port: device.port,
      username: device.username,
      vendor: device.vendor,
      model: device.model,
      firmware: device.firmware,
      host_key_fingerprint: device.host_key_fingerprint,
      identity_verified: Boolean(device.identity_verified),
      enabled: Boolean(device.enabled),
      notes: device.notes,
      has_secret: hasSecret(device.id),
      secret_updated_at: isoOrNull(device.secret_updated_at),
      reachable: device.reachable,
      collection_status: device.last_collection_status,
      last_ping: lastPing[0]
        ? {
            observed_at: lastPing[0].observed_at,
            reachable: lastPing[0].reachable === null ? null : Boolean(lastPing[0].reachable),
            latency_ms: lastPing[0].latency_ms,
            freshness: freshness(lastPing[0].observed_at, now, STALE_MS.ping),
          }
        : null,
      metrics,
      freshness: {
        uptime: freshness(device.uptime_last_valid_at, now, STALE_MS.metric),
        load: freshness(device.load_last_valid_at, now, STALE_MS.metric),
        ram: freshness(device.ram_last_valid_at, now, STALE_MS.metric),
        system: freshness(device.system_last_valid_at, now, STALE_MS.metric),
      },
    });
  }
  return result;
}

export async function getDevice(pool, id, hasSecret = () => false) {
  const rows = await pool.query(
    `SELECT id, name, ip, port, username, vendor, model, firmware,
            host_key_fingerprint, identity_verified, enabled, notes, secret_updated_at,
            reachable, last_ping_attempt_at, uptime_last_valid_at, load_last_valid_at,
            ram_last_valid_at, system_last_valid_at, last_collection_status
     FROM devices WHERE id = ?`,
    [id],
  );
  if (!rows[0]) return null;
  const device = rows[0];

  const metrics = await pool.query(
    `SELECT observed_at, collection_status, uptime_seconds, load_1, load_5, load_15,
            memory_total_bytes, memory_available_bytes, memory_used_bytes, memory_used_percent,
            reachable, latency_ms, metric_status
     FROM device_metrics WHERE device_id = ? ORDER BY observed_at DESC LIMIT 20`,
    [id],
  );

  const events = await pool.query(
    `SELECT id, type, started_at, changed_at, finished_at, status, detail
     FROM monitoring_events WHERE device_id = ? ORDER BY started_at DESC LIMIT 20`,
    [id],
  );

  const now = Date.now();
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    port: device.port,
    username: device.username,
    vendor: device.vendor,
    model: device.model,
    firmware: device.firmware,
    host_key_fingerprint: device.host_key_fingerprint,
    identity_verified: Boolean(device.identity_verified),
    enabled: Boolean(device.enabled),
    notes: device.notes,
    has_secret: hasSecret(device.id),
    secret_updated_at: isoOrNull(device.secret_updated_at),
    reachable: device.reachable,
    collection_status: device.last_collection_status,
    last_ping_attempt_at: device.last_ping_attempt_at,
    last_valid_at: {
      uptime: device.uptime_last_valid_at,
      load: device.load_last_valid_at,
      ram: device.ram_last_valid_at,
      system: device.system_last_valid_at,
    },
    freshness: {
      uptime: freshness(device.uptime_last_valid_at, now, STALE_MS.metric),
      load: freshness(device.load_last_valid_at, now, STALE_MS.metric),
      ram: freshness(device.ram_last_valid_at, now, STALE_MS.metric),
      system: freshness(device.system_last_valid_at, now, STALE_MS.metric),
    },
    metrics,
    events,
  };
}

export async function deviceExists(pool, id) {
  const rows = await pool.query('SELECT id FROM devices WHERE id = ?', [id]);
  return rows.length > 0;
}

export async function ipTaken(pool, ip, excludeId = null) {
  const rows = await pool.query('SELECT id FROM devices WHERE ip = ?', [ip]);
  return rows.some((row) => excludeId === null || Number(row.id) !== Number(excludeId));
}

// Kolom dari whitelist DEVICE_COLUMNS; nama kolom tidak pernah berasal dari masukan.
export async function createDevice(pool, fields) {
  const keys = DEVICE_COLUMNS.filter((key) => key in fields);
  const placeholders = keys.map(() => '?').join(', ');
  const result = await pool.query(
    `INSERT INTO devices (${keys.join(', ')}) VALUES (${placeholders})`,
    keys.map((key) => fields[key]),
  );
  return Number(result.insertId);
}

export async function updateDevice(pool, id, fields) {
  const keys = DEVICE_COLUMNS.filter((key) => key in fields);
  if (keys.length === 0) return 0;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const result = await pool.query(
    `UPDATE devices SET ${assignments} WHERE id = ?`,
    [...keys.map((key) => fields[key]), id],
  );
  return Number(result.affectedRows ?? 0);
}

export async function markSecretUpdated(pool, id) {
  await pool.query('UPDATE devices SET secret_updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [id]);
}

export async function clearSecretUpdated(pool, id) {
  await pool.query('UPDATE devices SET secret_updated_at = NULL WHERE id = ?', [id]);
}

export async function deleteDevice(pool, id) {
  const result = await pool.query('DELETE FROM devices WHERE id = ?', [id]);
  return Number(result.affectedRows ?? 0);
}

// Histori apa pun (metrik atau event) membuat penghapusan ditolak.
export async function deviceHasHistory(pool, id) {
  const rows = await pool.query(
    `SELECT (SELECT COUNT(*) FROM device_metrics WHERE device_id = ?) AS metrics,
            (SELECT COUNT(*) FROM monitoring_events WHERE device_id = ?) AS events`,
    [id, id],
  );
  const row = rows[0] ?? {};
  return Number(row.metrics ?? 0) > 0 || Number(row.events ?? 0) > 0;
}

// Rentang tervalidasi: default 1 jam, maksimum 24 jam.
export function parseRange(query, now = Date.now()) {
  const to = query.to ? Date.parse(query.to) : now;
  const from = query.from ? Date.parse(query.from) : to - HISTORY.defaultRangeMs;
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return { error: 'invalid_range' };
  }
  if (from >= to) return { error: 'invalid_range' };
  if (to - from > HISTORY.maxRangeMs) return { error: 'range_too_large' };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

// Rentang ringkasan: nama rentang → from/to + satu bucket per titik (maksimum 60 titik).
export function parseSummaryRange(query, now = Date.now()) {
  const name = query.range ?? '1h';
  const config = SUMMARY_RANGES[name];
  if (!config) return { error: 'invalid_range' };
  return {
    name,
    from: new Date(now - config.rangeMs).toISOString(),
    to: new Date(now).toISOString(),
    bucket_ms: config.bucketMs,
    buckets: Math.round(config.rangeMs / config.bucketMs),
  };
}

// Agregasi per bucket di SQL; slot tanpa data tetap null (bukan nol).
export async function summarySeries(pool, range) {
  const bucketSec = range.bucket_ms / 1000;
  const from = sqlTime(range.from);
  const to = sqlTime(range.to);

  const [latency, ram] = await Promise.all([
    pool.query(
      `SELECT device_id, FLOOR(UNIX_TIMESTAMP(observed_at) / ?) AS bucket, AVG(latency_ms) AS value
       FROM device_metrics
       WHERE kind = 'ping' AND observed_at BETWEEN ? AND ?
       GROUP BY device_id, bucket`,
      [bucketSec, from, to],
    ),
    pool.query(
      `SELECT device_id, FLOOR(UNIX_TIMESTAMP(observed_at) / ?) AS bucket, AVG(memory_used_percent) AS value
       FROM device_metrics
       WHERE kind = 'system' AND observed_at BETWEEN ? AND ?
       GROUP BY device_id, bucket`,
      [bucketSec, from, to],
    ),
  ]);

  const first = Math.floor(Date.parse(range.from) / 1000 / bucketSec);

  function emptySeries() {
    return { latency: new Array(range.buckets).fill(null), ram: new Array(range.buckets).fill(null) };
  }

  const series = {};
  function slot(deviceId) {
    const key = String(deviceId);
    series[key] ??= emptySeries();
    return series[key];
  }

  function fill(rows, field) {
    for (const row of rows) {
      const index = Number(row.bucket) - first;
      if (index < 0 || index >= range.buckets) continue;
      slot(row.device_id)[field][index] = row.value === null || row.value === undefined ? null : Number(row.value);
    }
  }

  fill(latency, 'latency');
  fill(ram, 'ram');
  return series;
}

export async function getMetrics(pool, id, range, kind) {
  const params = [id, sqlTime(range.from), sqlTime(range.to)];
  let sql = `SELECT observed_at, kind, collection_status, reachable, latency_ms,
                    uptime_seconds, load_1, load_5, load_15,
                    memory_used_bytes, memory_used_percent, metric_status
             FROM device_metrics
             WHERE device_id = ? AND observed_at BETWEEN ? AND ?`;
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY observed_at ASC LIMIT 5000';
  const rows = await pool.query(sql, params);
  // Gap kegagalan tetap null, bukan nol.
  return rows;
}

export async function listAlerts(pool, limit = 100) {
  return pool.query(
    `SELECT e.id, e.device_id, d.name AS device_name, e.type, e.started_at,
            e.changed_at, e.finished_at, e.status, e.detail
     FROM monitoring_events e
     JOIN devices d ON d.id = e.device_id
     ORDER BY e.started_at DESC
     LIMIT ?`,
    [limit],
  );
}

export async function getHealth(pool) {
  let dbOk = true;
  let dbCode = null;
  try {
    await pool.query('SELECT 1');
  } catch {
    dbOk = false;
    dbCode = 'db_unavailable';
  }

  let collector = { ok: false, last_heartbeat_at: null, code: 'no_heartbeat' };
  if (dbOk) {
    try {
      const rows = await pool.query(
        'SELECT last_heartbeat_at, last_error_code FROM collector_heartbeat WHERE id = 1',
      );
      if (rows[0]?.last_heartbeat_at) {
        const age = Date.now() - new Date(rows[0].last_heartbeat_at).getTime();
        collector = {
          ok: age <= 90_000,
          last_heartbeat_at: rows[0].last_heartbeat_at,
          code: age <= 90_000 ? null : 'collector_stale',
        };
      }
    } catch {
      collector = { ok: false, last_heartbeat_at: null, code: 'db_unavailable' };
    }
  }

  return { ok: dbOk && collector.ok, db: { ok: dbOk, code: dbCode }, collector };
}
