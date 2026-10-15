// Query terparameter, tanpa penyambungan string masukan §7.
import { HISTORY, STALE_MS } from '@ama/shared';

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

export async function listDevices(pool) {
  const devices = await pool.query(
    `SELECT id, name, ip, vendor, model, firmware, identity_verified,
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
      vendor: device.vendor,
      model: device.model,
      firmware: device.firmware,
      identity_verified: Boolean(device.identity_verified),
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

export async function getDevice(pool, id) {
  const rows = await pool.query(
    `SELECT id, name, ip, vendor, model, firmware, identity_verified,
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
    vendor: device.vendor,
    model: device.model,
    firmware: device.firmware,
    identity_verified: Boolean(device.identity_verified),
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
    },
    metrics,
    events,
  };
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

export async function getMetrics(pool, id, range, kind) {
  const params = [id, range.from.replace('T', ' ').replace('Z', ''), range.to.replace('T', ' ').replace('Z', '')];
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
