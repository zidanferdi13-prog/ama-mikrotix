// Query terparameter, tanpa penyambungan string masukan §7.
import { HISTORY, INTERNET_COLUMNS, LINK_COLUMNS, RADIO_COLUMNS, STALE_MS } from '@ama/shared';

// Kolom link/radio dari mca-dump (migrasi 006) + ping AP → internet (008) — grafik & kartu detail.
const LINK_RADIO_SQL = [...LINK_COLUMNS, ...RADIO_COLUMNS, ...INTERNET_COLUMNS].join(', ');

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
              internet_latency_ms, internet_loss_percent, metric_status
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
    // Latency utama = ping AP → google.com (SSH). Ping server → AP hanya keterjangkauan.
    const internetStatus = row?.metric_status?.internet ?? null;
    const internet = row
      ? {
          observed_at: isoOrNull(row.observed_at),
          latency_ms: row.internet_latency_ms ?? null,
          loss_percent: row.internet_loss_percent ?? null,
          status: internetStatus?.status ?? null,
          code: internetStatus?.code ?? null,
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
      last_collected_at: isoOrNull(row?.observed_at),
      last_ping: lastPing[0]
        ? {
            observed_at: lastPing[0].observed_at,
            reachable: lastPing[0].reachable === null ? null : Boolean(lastPing[0].reachable),
            latency_ms: lastPing[0].latency_ms,
            freshness: freshness(lastPing[0].observed_at, now, STALE_MS.ping),
          }
        : null,
      metrics,
      internet,
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

// Histori apa pun (metrik, event, atau aksi kontrol) membuat penghapusan ditolak.
export async function deviceHasHistory(pool, id) {
  const rows = await pool.query(
    `SELECT (SELECT COUNT(*) FROM device_metrics WHERE device_id = ?) AS metrics,
            (SELECT COUNT(*) FROM monitoring_events WHERE device_id = ?) AS events,
            (SELECT COUNT(*) FROM device_actions WHERE device_id = ?) AS actions`,
    [id, id, id],
  );
  const row = rows[0] ?? {};
  return Number(row.metrics ?? 0) > 0 || Number(row.events ?? 0) > 0 || Number(row.actions ?? 0) > 0;
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
      `SELECT device_id, FLOOR(UNIX_TIMESTAMP(observed_at) / ?) AS bucket, AVG(internet_latency_ms) AS value
       FROM device_metrics
       WHERE kind = 'system' AND observed_at BETWEEN ? AND ?
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
                    memory_used_bytes, memory_used_percent, client_count, metric_status, ${LINK_RADIO_SQL}
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

// --- Alert Center §7–§8 -------------------------------------------------------

const SEVERITIES = ['critical', 'warning', 'info'];
const ALERT_STATUSES = ['active', 'acknowledged', 'resolved'];
const ALERT_FIELDS = `a.id, a.rule_id, a.severity, a.status, a.device_id, d.name AS device_name,
       a.target, a.title, a.first_seen_at, a.last_seen_at, a.updated_at, a.resolved_at,
       a.acknowledged_at, a.acknowledged_by, a.reopen_count, a.evidence, a.diagnosis`;

function jsonOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function alertRow(row, now = Date.now()) {
  const first = isoOrNull(row.first_seen_at);
  const end = isoOrNull(row.resolved_at) ?? new Date(now).toISOString();
  return {
    id: Number(row.id),
    rule_id: row.rule_id,
    severity: row.severity,
    status: row.status,
    device_id: row.device_id === null || row.device_id === undefined ? null : Number(row.device_id),
    device_name: row.device_name ?? null,
    target: row.target ?? null,
    title: row.title,
    first_seen_at: first,
    last_seen_at: isoOrNull(row.last_seen_at),
    updated_at: isoOrNull(row.updated_at),
    resolved_at: isoOrNull(row.resolved_at),
    acknowledged_at: isoOrNull(row.acknowledged_at),
    acknowledged_by: row.acknowledged_by ?? null,
    reopen_count: Number(row.reopen_count ?? 0),
    duration_ms: first === null ? null : Math.max(0, Date.parse(end) - Date.parse(first)),
    evidence: jsonOrNull(row.evidence),
    diagnosis: jsonOrNull(row.diagnosis),
  };
}

// Filter tervalidasi §9: nilai di luar daftar ditolak, bukan diabaikan diam-diam.
export function parseAlertQuery(query = {}, now = Date.now()) {
  const filters = { severity: null, status: null, device_id: null, from: null, to: null };
  if (query.severity) {
    if (!SEVERITIES.includes(query.severity)) return { error: 'invalid_severity' };
    filters.severity = query.severity;
  }
  if (query.status) {
    if (!ALERT_STATUSES.includes(query.status)) return { error: 'invalid_status' };
    filters.status = query.status;
  }
  if (query.device_id !== undefined && query.device_id !== '') {
    if (!/^\d+$/.test(String(query.device_id))) return { error: 'invalid_device_id' };
    filters.device_id = Number(query.device_id);
  }
  if (query.from) {
    const from = Date.parse(query.from);
    if (Number.isNaN(from)) return { error: 'invalid_range' };
    filters.from = new Date(from).toISOString();
  }
  if (query.to) {
    const to = Date.parse(query.to);
    if (Number.isNaN(to)) return { error: 'invalid_range' };
    filters.to = new Date(to).toISOString();
  }
  if (filters.from && filters.to && Date.parse(filters.from) >= Date.parse(filters.to)) {
    return { error: 'invalid_range' };
  }
  // Rentang efektif (termasuk batas default) dibatasi 24 jam seperti riwayat metrik.
  const period = { from: filters.from ?? new Date(now - HISTORY.defaultRangeMs).toISOString(), to: filters.to ?? new Date(now).toISOString() };
  if (Date.parse(period.to) - Date.parse(period.from) > HISTORY.maxRangeMs) return { error: 'range_too_large' };
  const limit = query.limit === undefined || query.limit === '' ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return { error: 'invalid_limit' };
  const offset = query.offset === undefined || query.offset === '' ? 0 : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0) return { error: 'invalid_offset' };
  return { filters, limit, offset, period };
}

export async function listAlertCenter(pool, { filters, limit, offset }) {
  const params = [];
  let sql = `SELECT ${ALERT_FIELDS} FROM alerts a LEFT JOIN devices d ON d.id = a.device_id WHERE 1 = 1`;
  if (filters.severity) {
    sql += ' AND a.severity = ?';
    params.push(filters.severity);
  }
  if (filters.status) {
    sql += ' AND a.status = ?';
    params.push(filters.status);
  }
  if (filters.device_id !== null) {
    sql += ' AND a.device_id = ?';
    params.push(filters.device_id);
  }
  if (filters.from) {
    sql += ' AND a.last_seen_at >= ?';
    params.push(sqlTime(filters.from));
  }
  if (filters.to) {
    sql += ' AND a.last_seen_at <= ?';
    params.push(sqlTime(filters.to));
  }
  // Terbuka dulu, lalu terberat: operator melihat yang butuh tindakan lebih dahulu.
  sql += ` ORDER BY FIELD(a.status, 'active', 'acknowledged', 'resolved'),
                    FIELD(a.severity, 'critical', 'warning', 'info'),
                    a.last_seen_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = await pool.query(sql, params);
  return rows.map((row) => alertRow(row));
}

// Ringkasan §7.A: angka nyata dari DB, bukan dummy.
export async function alertSummary(pool, period, now = Date.now()) {
  const [grouped, resolved, affected, incidents, heartbeat] = await Promise.all([
    pool.query('SELECT severity, status, COUNT(*) AS n FROM alerts GROUP BY severity, status'),
    pool.query('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at BETWEEN ? AND ?', [sqlTime(period.from), sqlTime(period.to)]),
    pool.query('SELECT COUNT(DISTINCT device_id) AS n FROM alerts WHERE status <> ? AND device_id IS NOT NULL', ['resolved']),
    pool.query("SELECT COUNT(*) AS n FROM alerts WHERE status <> ? AND rule_id LIKE 'incident.%'", ['resolved']),
    pool.query('SELECT last_heartbeat_at FROM collector_heartbeat WHERE id = 1'),
  ]);

  const by_severity = { critical: 0, warning: 0, info: 0 };
  const by_status = { active: 0, acknowledged: 0, resolved: 0 };
  let open = 0;
  for (const row of grouped) {
    by_status[row.status] = (by_status[row.status] ?? 0) + Number(row.n);
    if (row.status !== 'resolved') {
      by_severity[row.severity] = (by_severity[row.severity] ?? 0) + Number(row.n);
      open += Number(row.n);
    }
  }

  // Driver bisa mengembalikan Date, bukan string: normalisasi sebelum dihitung.
  const lastHeartbeat = isoOrNull(heartbeat[0]?.last_heartbeat_at);
  const collectorAgeMs = lastHeartbeat ? now - Date.parse(lastHeartbeat) : null;
  return {
    period,
    open,
    by_severity,
    by_status,
    incidents_open: Number(incidents[0]?.n ?? 0),
    devices_affected: Number(affected[0]?.n ?? 0),
    resolved_in_period: Number(resolved[0]?.n ?? 0),
    collector: {
      last_heartbeat_at: isoOrNull(lastHeartbeat),
      age_ms: collectorAgeMs,
      fresh: collectorAgeMs !== null && collectorAgeMs <= 90_000,
    },
  };
}

// Detail insiden §7.C: evidence, langkah, metrik sebelum/selama/sesudah, client, alert terkait.
export async function getAlert(pool, id, now = Date.now()) {
  const rows = await pool.query(
    `SELECT ${ALERT_FIELDS} FROM alerts a LEFT JOIN devices d ON d.id = a.device_id WHERE a.id = ?`,
    [id],
  );
  if (!rows[0]) return null;
  const alert = alertRow(rows[0], now);

  const events = await pool.query(
    'SELECT at, from_status, to_status, actor, note FROM alert_events WHERE alert_id = ? ORDER BY at ASC, id ASC LIMIT 200',
    [id],
  );

  const context = {
    phases: {
      before_from: new Date(Date.parse(alert.first_seen_at) - 10 * 60 * 1000).toISOString(),
      during_from: alert.first_seen_at,
      during_to: alert.resolved_at ?? new Date(now).toISOString(),
      after_to: new Date(Date.parse(alert.resolved_at ?? new Date(now).toISOString()) + 10 * 60 * 1000).toISOString(),
    },
    metrics: [],
    clients: [],
    related_alerts: [],
  };

  if (alert.device_id !== null) {
    const [metrics, clients] = await Promise.all([
      pool.query(
        `SELECT observed_at, kind, collection_status, reachable, latency_ms, memory_used_percent,
                load_1, client_count, ${LINK_RADIO_SQL}
         FROM device_metrics
         WHERE device_id = ? AND observed_at BETWEEN ? AND ? AND kind IN ('ping','system')
         ORDER BY observed_at ASC LIMIT 2000`,
        [alert.device_id, sqlTime(context.phases.before_from), sqlTime(context.phases.after_to)],
      ),
      pool.query(
        `SELECT mac, COUNT(*) AS snapshots, MAX(observed_at) AS last_seen_at,
                MAX(signal_dbm) AS best_signal_dbm, MIN(signal_dbm) AS worst_signal_dbm
         FROM client_observations
         WHERE device_id = ? AND observed_at BETWEEN ? AND ?
         GROUP BY mac ORDER BY mac ASC LIMIT 200`,
        [alert.device_id, sqlTime(alert.first_seen_at), sqlTime(context.phases.during_to)],
      ),
    ]);
    context.metrics = metrics;
    context.clients = clients.map((row) => ({
      mac: row.mac,
      snapshots: Number(row.snapshots),
      last_seen_at: isoOrNull(row.last_seen_at),
      best_signal_dbm: row.best_signal_dbm === null ? null : Number(row.best_signal_dbm),
      worst_signal_dbm: row.worst_signal_dbm === null ? null : Number(row.worst_signal_dbm),
    }));
  }

  // Alert per-perangkat yang bergabung ke satu insiden (evidence.affected_devices).
  if (alert.rule_id.startsWith('incident.')) {
    const affectedDevices = (alert.diagnosis?.affected_devices ?? []).filter((value) => Number.isInteger(Number(value)));
    if (affectedDevices.length > 0) {
      const related = await pool.query(
        `SELECT ${ALERT_FIELDS} FROM alerts a LEFT JOIN devices d ON d.id = a.device_id
         WHERE a.id <> ? AND a.rule_id NOT LIKE 'incident.%'
           AND a.first_seen_at BETWEEN ? AND ?
           AND a.device_id IN (?)
         ORDER BY a.last_seen_at DESC LIMIT 100`,
        [id, sqlTime(new Date(Date.parse(alert.first_seen_at) - 5 * 60 * 1000).toISOString()), sqlTime(context.phases.during_to), affectedDevices],
      );
      context.related_alerts = related.map((row) => alertRow(row, now));
    }
  }

  return {
    alert,
    events: events.map((row) => ({
      at: isoOrNull(row.at),
      from_status: row.from_status ?? null,
      to_status: row.to_status,
      actor: row.actor,
      note: jsonOrNull(row.note),
    })),
    context,
  };
}

// Acknowledge tidak pernah menyelesaikan insiden §7.D. Satu transaksi + FOR UPDATE
// supaya dua operator yang menekan bersamaan tidak menulis dua riwayat.
async function setAlertStatus(pool, { id, user, status, at }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const rows = await conn.query('SELECT id, status FROM alerts WHERE id = ? FOR UPDATE', [id]);
    if (!rows[0]) {
      await conn.rollback();
      return { error: 'not_found' };
    }
    const from = rows[0].status;
    if (from === 'resolved') {
      await conn.rollback();
      return { error: 'already_resolved' };
    }
    if (from === status) {
      await conn.commit();
      return { unchanged: true, from, status, id };
    }

    if (status === 'acknowledged') {
      await conn.query(
        'UPDATE alerts SET status = ?, acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?',
        [status, at, user, at, id],
      );
    } else {
      await conn.query('UPDATE alerts SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?', [status, at, at, id]);
    }
    await conn.query(
      'INSERT INTO alert_events (alert_id, at, from_status, to_status, actor, note) VALUES (?,?,?,?,?,?)',
      [id, at, from, status, user, JSON.stringify({ via: 'api' })],
    );
    await conn.commit();
    return { id, from, status, at: isoOrNull(at), user };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export function ackAlert(pool, { id, user, at = new Date() }) {
  return setAlertStatus(pool, { id, user, status: 'acknowledged', at });
}

export function resolveAlert(pool, { id, user, at = new Date() }) {
  return setAlertStatus(pool, { id, user, status: 'resolved', at });
}

// --- Aksi kontrol AP (migrasi 007) ---------------------------------------------

export async function insertDeviceAction(pool, { deviceId, action, user, status, errorCode = null, at = new Date() }) {
  await pool.query(
    'INSERT INTO device_actions (device_id, action, requested_by, requested_at, status, error_code) VALUES (?,?,?,?,?,?)',
    [deviceId, action, user, at, status, errorCode],
  );
}

// Waktu aksi terkirim terakhir (untuk cooldown); aksi gagal tidak dihitung.
export async function lastSentActionAt(pool, deviceId, action) {
  const rows = await pool.query(
    "SELECT MAX(requested_at) AS at FROM device_actions WHERE device_id = ? AND action = ? AND status = 'sent'",
    [deviceId, action],
  );
  return isoOrNull(rows[0]?.at);
}

export async function listDeviceActions(pool, deviceId, limit = 20) {
  const rows = await pool.query(
    `SELECT id, action, requested_by, requested_at, status, error_code
     FROM device_actions WHERE device_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?`,
    [deviceId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    action: row.action,
    requested_by: row.requested_by,
    requested_at: isoOrNull(row.requested_at),
    status: row.status,
    error_code: row.error_code ?? null,
  }));
}
