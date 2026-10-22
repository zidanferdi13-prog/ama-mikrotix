// Persistensi §6: satu transaksi per siklus. Rollback → tandai gagal, tanpa emit sukses.
import { INTERNET_COLUMNS, LINK_COLUMNS, RADIO_COLUMNS, REACHABLE, applyPingTransition } from '@ama/shared';
import { log } from './logger.js';

// Kolom link/radio (migrasi 006) + internet (008) — nama dari konstanta, bukan masukan pengguna.
const LINK_RADIO = [...LINK_COLUMNS, ...RADIO_COLUMNS, ...INTERNET_COLUMNS];

// Perintah tetap tanpa string masukan pengguna.
const SQL = {
  insertMetric: `INSERT INTO device_metrics
      (device_id, kind, observed_at, received_at, collection_status,
       reachable, latency_ms, uptime_seconds, load_1, load_5, load_15,
       memory_total_bytes, memory_available_bytes, memory_used_bytes, memory_used_percent,
       client_count, metric_status, ${LINK_RADIO.join(', ')})
    VALUES (${Array(17 + LINK_RADIO.length).fill('?').join(',')})`,
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
  // Identitas AP dari perangkat itu sendiri (mca-dump) lewat sesi SSH yang host key-nya
  // sudah dicocokkan dengan yang di-pin → layak ditandai terverifikasi. `<=>` = null-safe:
  // baris tidak ditulis ulang bila nilainya sama (tiap siklus, 9 AP).
  updateIdentity: `UPDATE devices SET vendor = ?, model = ?, firmware = ?, identity_verified = 1
    WHERE id = ? AND NOT (identity_verified = 1 AND vendor <=> ? AND model <=> ? AND firmware <=> ?)`,
  insertEvent: `INSERT INTO monitoring_events
      (device_id, type, started_at, changed_at, finished_at, status, detail)
    VALUES (?,?,?,?,?,?,?)`,
  closeActiveEvent: `UPDATE monitoring_events
      SET status = 'selesai', finished_at = ?
    WHERE device_id = ? AND type = 'device.status.changed' AND status = 'aktif'`,
  // Snapshot client per siklus sistem; identitas = (device_id, mac). Hostname/IP tidak disimpan.
  clientColumns: `INSERT INTO client_observations
      (device_id, mac, observed_at, signal_dbm, rssi, rx_bytes, tx_bytes, uptime_s, radio, vap) VALUES `,
  // Retensi: hapus berdasarkan umur. alert_events ikut terhapus (FK ON DELETE CASCADE).
  // ponytail: device_metrics tidak punya indeks yang diawali observed_at → scan penuh
  // tiap jam (~200 MB pada 30 hari). Bila terasa lambat, tambah migrasi indeks observed_at.
  prune: {
    clients: 'DELETE FROM client_observations WHERE observed_at < ?',
    metrics: 'DELETE FROM device_metrics WHERE observed_at < ?',
    alerts: "DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?",
  },
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
      null, null, null, null, null, null, null, null, null,
      JSON.stringify({ reachable: { status: sample.reachable === null ? 'unsupported' : 'ok', code: sample.code ?? null } }),
      ...LINK_RADIO.map(() => null),
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
      sample.client_count,
      JSON.stringify(sample.metric_status ?? {}),
      ...LINK_RADIO.map((c) => sample[c] ?? null),
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

// Terpisah dari transaksi metrik: tabel/migrasi alert yang belum ada tidak boleh
// menggagalkan metrik sistem. Hanya snapshot SUKSES yang ditulis; snapshot kosong-sukses
// ditandai metric_status.client_count.status='ok' pada baris sistem yang sama.
export async function persistClients(pool, deviceId, observedAt, clients) {
  if (!clients.length) return true;
  const at = dt(observedAt);
  try {
    await pool.query(
      SQL.clientColumns + clients.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(','),
      clients.flatMap((c) => [deviceId, c.mac, at, c.signal_dbm, c.rssi, c.rx_bytes, c.tx_bytes, c.uptime_s, c.radio, c.vap]),
    );
    return true;
  } catch (err) {
    log.error({ event: 'persist_failed', deviceId, kind: 'clients', code: err.message });
    return false;
  }
}

// Identitas perangkat: menulis hanya saat berbeda. Mengembalikan true bila baris berubah.
export async function persistIdentity(pool, deviceId, identity) {
  try {
    const result = await pool.query(SQL.updateIdentity, [
      identity.vendor,
      identity.model,
      identity.firmware,
      deviceId,
      identity.vendor,
      identity.model,
      identity.firmware,
    ]);
    return Number(result.affectedRows ?? 0) > 0;
  } catch (err) {
    log.error({ event: 'persist_failed', deviceId, kind: 'identity', code: err.message });
    return false;
  }
}

export async function prune(pool, kind, beforeMs) {
  try {
    await pool.query(SQL.prune[kind], [dt(beforeMs)]);
  } catch (err) {
    log.error({ event: 'prune_failed', kind, code: err.message });
  }
}

export async function writeHeartbeat(pool, errorCode = null) {
  try {
    await pool.query(SQL.heartbeat, [dt(new Date()), errorCode]);
  } catch (err) {
    log.error({ event: 'heartbeat_failed', code: err.message });
  }
}
