// Persistensi §6: satu transaksi per siklus. Rollback → tandai gagal, tanpa emit sukses.
import { REACHABLE, applyPingTransition } from '@ama/shared';
import { log } from './logger.js';

// Perintah tetap tanpa string masukan pengguna.
const SQL = {
  insertMetric: `INSERT INTO device_metrics
      (device_id, kind, observed_at, received_at, collection_status,
       reachable, latency_ms, uptime_seconds, load_1, load_5, load_15,
       memory_total_bytes, memory_available_bytes, memory_used_bytes, memory_used_percent,
       metric_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  selectDevice: 'SELECT * FROM devices WHERE id = ? FOR UPDATE',
  updateDevice: `UPDATE devices SET
      reachable = ?, ping_fail_count = ?, ping_ok_count = ?, last_ping_attempt_at = ?
    WHERE id = ?`,
  updateLastValid: `UPDATE devices SET
      uptime_last_valid_at = COALESCE(?, uptime_last_valid_at),
      load_last_valid_at = COALESCE(?, load_last_valid_at),
      ram_last_valid_at = COALESCE(?, ram_last_valid_at),
      system_last_valid_at = COALESCE(?, system_last_valid_at),
      last_collection_status = ?
    WHERE id = ?`,
  insertEvent: `INSERT INTO monitoring_events
      (device_id, type, started_at, changed_at, finished_at, status, detail)
    VALUES (?,?,?,?,?,?,?)`,
  closeActiveEvent: `UPDATE monitoring_events
      SET status = 'selesai', finished_at = ?
    WHERE device_id = ? AND type = 'device.status.changed' AND status = 'aktif'`,
  heartbeat: `INSERT INTO collector_heartbeat (id, last_heartbeat_at, last_error_code)
    VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE last_heartbeat_at = VALUES(last_heartbeat_at), last_error_code = VALUES(last_error_code)`,
};

// MariaDB DATETIME(3) menolak bentuk ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'.
const dt = (iso) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');

function metricGroupFlags(sample) {
  const s = sample.metric_status ?? {};
  const isOk = (k) => s[k]?.status === 'ok';
  const uptimeOk = isOk('uptime_seconds');
  const loadOk = isOk('load_1');
  const ramOk = isOk('memory_used_percent');
  return {
    uptimeLastValid: uptimeOk ? dt(sample.observed_at) : null,
    loadLastValid: loadOk ? dt(sample.observed_at) : null,
    ramLastValid: ramOk ? dt(sample.observed_at) : null,
    // Timestamp grup hanya naik bila ada metrik valid pada siklus ini.
    systemLastValid: uptimeOk || loadOk || ramOk ? dt(sample.observed_at) : null,
  };
}

// Simpan sampel ping + transisi + event dalam satu transaksi.
export async function persistPing(pool, sample) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [device] = await conn.query(SQL.selectDevice, [sample.device_id]);
    if (!device) throw new Error('device_not_found');

    const prevState = {
      reachable:
        device.reachable === 'up' || device.reachable === 'down' ? device.reachable : REACHABLE.unknown,
      failCount: device.ping_fail_count ?? 0,
      okCount: device.ping_ok_count ?? 0,
    };
    const { state, event } = applyPingTransition(prevState, { reachable: sample.reachable });

    await conn.query(SQL.insertMetric, [
      sample.device_id,
      'ping',
      dt(sample.observed_at),
      dt(sample.received_at ?? sample.observed_at),
      sample.collection_status,
      sample.reachable === null ? null : sample.reachable ? 1 : 0,
      sample.latency_ms,
      null, null, null, null, null, null, null, null,
      JSON.stringify({ reachable: { status: sample.reachable === null ? 'unsupported' : 'ok', code: sample.code ?? null } }),
    ]);

    await conn.query(SQL.updateDevice, [
      state.reachable,
      state.failCount,
      state.okCount,
      dt(sample.observed_at),
      sample.device_id,
    ]);

    let emitted = null;
    if (event) {
      await conn.query(SQL.closeActiveEvent, [dt(sample.observed_at), sample.device_id]);
      const type = event === 'down' ? 'device.down' : 'device.recovered';
      await conn.query(SQL.insertEvent, [
        sample.device_id,
        'device.status.changed',
        dt(sample.observed_at),
        dt(sample.observed_at),
        event === 'down' ? null : dt(sample.observed_at),
        event === 'down' ? 'aktif' : 'selesai',
        JSON.stringify({ transition: type, to: state.reachable }),
      ]);
      emitted = { type: 'device.status.changed', deviceId: sample.device_id, transition: type, to: state.reachable };
    }

    await conn.commit();
    return { committed: true, event: emitted };
  } catch (err) {
    await conn.rollback().catch(() => {});
    log.error({ event: 'persist_failed', deviceId: sample.device_id, kind: 'ping', code: err.message });
    return { committed: false, event: null };
  } finally {
    conn.release();
  }
}

// Simpan sampel sistem. Sampel partial hanya memperbarui metrik yang valid.
export async function persistSystem(pool, sample) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [device] = await conn.query(SQL.selectDevice, [sample.device_id]);
    if (!device) throw new Error('device_not_found');

    const flags = metricGroupFlags(sample);
    await conn.query(SQL.insertMetric, [
      sample.device_id,
      'system',
      dt(sample.observed_at),
      dt(sample.received_at ?? sample.observed_at),
      sample.collection_status,
      null, null,
      sample.uptime_seconds,
      sample.load_1,
      sample.load_5,
      sample.load_15,
      sample.memory_total_bytes,
      sample.memory_available_bytes,
      sample.memory_used_bytes,
      sample.memory_used_percent,
      JSON.stringify(sample.metric_status ?? {}),
    ]);

    await conn.query(SQL.updateLastValid, [
      flags.uptimeLastValid,
      flags.loadLastValid,
      flags.ramLastValid,
      flags.systemLastValid,
      sample.collection_status,
      sample.device_id,
    ]);

    await conn.commit();
    return { committed: true, event: null };
  } catch (err) {
    await conn.rollback().catch(() => {});
    log.error({ event: 'persist_failed', deviceId: sample.device_id, kind: 'system', code: err.message });
    return { committed: false, event: null };
  } finally {
    conn.release();
  }
}

export async function writeHeartbeat(pool, errorCode = null) {
  try {
    await pool.query(SQL.heartbeat, [dt(new Date()), errorCode]);
  } catch (err) {
    log.error({ event: 'heartbeat_failed', code: err.message });
  }
}
