// Job evaluasi alert §4–§6: transaksi SENDIRI, setelah metrik di-commit.
// Tabel alert yang belum ada (migrasi 005 belum jalan) hanya membuat log
// alert_eval_failed; penulisan metrik tidak terpengaruh.
// Kunci GET_LOCK: satu evaluasi pada satu waktu; UNIQUE open_key jadi jaring terakhir.
import {
  ALERT,
  ALERT_RULES,
  alertDedupKey,
  correlateAlerts,
  evaluateClientRules,
  evaluateDeviceRules,
  planAlertChanges,
} from '@ama/shared';
import { prune } from './persist.js';
import { log } from './logger.js';

const LOCK_NAME = 'ama_alert_eval';
const PRUNE_MS = 60 * 60 * 1000;
const DT = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const DAY_MS = 24 * 60 * 60 * 1000;
const j = (value) => JSON.stringify(value ?? null);
// MariaDB menyimpan JSON sebagai LONGTEXT; driver bisa mengembalikan string.
function jsonOf(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
const iso = (value) => (value ? new Date(value).toISOString() : null);

async function loadState(conn, atMs) {
  const since = DT(atMs - ALERT.windowMs);
  const flapSince = DT(atMs - ALERT.apFlapping.windowMs);
  const [devices, metrics, events, observations, heartbeatRows, openRows] = await Promise.all([
    conn.query('SELECT id, name FROM devices WHERE enabled = 1 ORDER BY id'),
    conn.query(
      `SELECT device_id, kind, observed_at, collection_status, reachable, latency_ms,
              memory_used_percent, load_1, client_count, metric_status
       FROM device_metrics WHERE observed_at >= ? ORDER BY device_id, observed_at ASC`,
      [since],
    ),
    conn.query(
      `SELECT device_id, type, started_at, detail FROM monitoring_events
       WHERE type = 'device.status.changed' AND started_at >= ? ORDER BY started_at ASC`,
      [flapSince],
    ),
    conn.query(
      `SELECT device_id, mac, observed_at, signal_dbm, rssi, rx_bytes, tx_bytes
       FROM client_observations WHERE observed_at >= ? ORDER BY device_id, observed_at ASC`,
      [since],
    ),
    conn.query('SELECT last_heartbeat_at FROM collector_heartbeat WHERE id = 1'),
    conn.query(
      `SELECT id, rule_id, status, device_id, target, dedup_key, first_seen_at, last_seen_at, resolved_at,
              evidence, diagnosis
       FROM alerts WHERE status <> 'resolved' OR resolved_at >= ?`,
      [DT(atMs - ALERT.cooldownMs - DAY_MS)],
    ),
  ]);
  // Driver mengembalikan DATETIME sebagai Date; longgar terhadap keduanya.
  const heartbeatAt = heartbeatRows[0]?.last_heartbeat_at ?? null;
  const heartbeatAtMs = heartbeatAt ? new Date(heartbeatAt).getTime() : null;
  return { devices, metrics, events, observations, heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null, openRows };
}

// Kelompokkan per perangkat: histori ping, histori sistem, sampel SSH, titik client.
function shapeInputs(state, atMs) {
  const perDevice = new Map();
  const bucket = (deviceId) => {
    if (!perDevice.has(deviceId)) {
      perDevice.set(deviceId, { ping: [], system: [], systemSamples: [], events: [], observed: new Map() });
    }
    return perDevice.get(deviceId);
  };

  for (const row of state.metrics) {
    const deviceId = Number(row.device_id);
    const metricStatus = jsonOf(row.metric_status) ?? {};
    if (row.kind === 'ping') {
      bucket(deviceId).ping.push({
        observed_at: iso(row.observed_at),
        reachable: row.reachable === null ? null : Number(row.reachable),
        latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
        code: metricStatus.reachable?.code ?? null,
      });
      continue;
    }
    const at = iso(row.observed_at);
    const entry = bucket(deviceId);
    entry.system.push({
      observed_at: at,
      collection_status: row.collection_status,
      uptime_seconds: row.uptime_seconds === null ? null : Number(row.uptime_seconds),
      load_1: row.load_1 === null ? null : Number(row.load_1),
      memory_used_percent: row.memory_used_percent === null ? null : Number(row.memory_used_percent),
      client_count: row.client_count === null ? null : Number(row.client_count),
    });
    entry.systemSamples.push({ observed_at: at, ssh: metricStatus.ssh ?? null });
    // Snapshot client dianggap SUKSES hanya bila client_count berstatus ok:
    // sampel kosong yang sukses tetap terhitung, kegagalan koleksi tidak.
    if (metricStatus.client_count?.status === 'ok') entry.observed.set(at, []);
  }

  for (const row of state.observations) {
    const entry = perDevice.get(Number(row.device_id));
    const at = iso(row.observed_at);
    const list = entry?.observed.get(at);
    if (!list) continue; // observasi tanpa baris sistem yang cocok diabaikan
    list.push({
      mac: row.mac,
      signal_dbm: row.signal_dbm === null ? null : Number(row.signal_dbm),
      rssi: row.rssi === null ? null : Number(row.rssi),
      rx_bytes: row.rx_bytes === null ? null : Number(row.rx_bytes),
      tx_bytes: row.tx_bytes === null ? null : Number(row.tx_bytes),
    });
  }

  for (const row of state.events) {
    const entry = perDevice.get(Number(row.device_id));
    if (!entry) continue;
    entry.events.push({ type: row.type, started_at: iso(row.started_at), detail: jsonOf(row.detail) });
  }

  const inputs = new Map();
  for (const [deviceId, entry] of perDevice) {
    const points = [...entry.observed.entries()]
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
      .map(([at, clients]) => ({ observed_at: at, clients }));
    inputs.set(deviceId, {
      ping: entry.ping[entry.ping.length - 1] ?? null,
      pingHistory: entry.ping,
      system: entry.system[entry.system.length - 1] ?? null,
      systemHistory: entry.system,
      systemSamples: entry.systemSamples,
      events: entry.events,
      points,
      atMs,
    });
  }
  return inputs;
}

// Snapshot client TERAKHIR per AP (hanya snapshot yang sukses), dipakai memutuskan roaming.
function latestClientSnapshots(inputs, atMs) {
  const perDevice = new Map();
  for (const [deviceId, input] of inputs) {
    const last = input.points[input.points.length - 1] ?? null;
    if (!last) continue;
    const at = Date.parse(last.observed_at);
    if (!Number.isFinite(at) || atMs - at > ALERT.clientElsewhereMs) continue;
    perDevice.set(Number(deviceId), { atMs: at, macs: new Set((last.clients ?? []).map((c) => c.mac)) });
  }
  return perDevice;
}

// MAC yang masih terlihat pada snapshot terakhir AP LAIN: itu roaming, bukan hilang.
function elsewhereFor(snapshots, deviceId) {
  const map = new Map();
  for (const [otherId, snap] of snapshots) {
    if (otherId === Number(deviceId)) continue;
    for (const mac of snap.macs) {
      const prev = map.get(mac);
      if (!prev || snap.atMs > prev.atMs) map.set(mac, { atMs: snap.atMs, deviceId: otherId });
    }
  }
  return map;
}

async function applyOps(conn, ops, atMs, statusById = new Map()) {
  const at = DT(atMs);
  let created = 0;
  let reopened = 0;
  let touched = 0;
  let resolved = 0;
  for (const op of ops) {
    const { desired } = op;
    const meta = ALERT_RULES[desired.rule_id] ?? { severity: 'info', title: desired.rule_id };
    const target = desired.target ?? null;
    const dedupKey = alertDedupKey({ rule_id: desired.rule_id, device_id: desired.device_id ?? null, target });
    const deviceId = desired.device_id ?? null;
    const evidence = desired.evidence ?? {};
    const event = j({ rule_id: desired.rule_id, severity: meta.severity });

    if (op.op === 'create') {
      const result = await conn.query(
        `INSERT INTO alerts
           (rule_id, severity, status, device_id, target, dedup_key, title,
            first_seen_at, last_seen_at, updated_at, evidence, diagnosis)
         VALUES (?,?, 'active', ?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
           last_seen_at = VALUES(last_seen_at), updated_at = VALUES(updated_at),
           evidence = VALUES(evidence), diagnosis = VALUES(diagnosis)`,
        [
          desired.rule_id,
          meta.severity,
          deviceId,
          target,
          dedupKey,
          desired.title ?? meta.title,
          DT(Date.parse(desired.since ?? new Date(atMs).toISOString())),
          at,
          at,
          j(evidence),
          j(desired.diagnosis),
        ],
      );
      const id = Number(result.insertId);
      created += 1;
      if (Number(result.affectedRows) === 1) {
        await conn.query(
          'INSERT INTO alert_events (alert_id, at, from_status, to_status, actor, note) VALUES (?,?,?,?,?,?)',
          [id, at, null, 'active', 'system', event],
        );
      }
    } else if (op.op === 'reopen') {
      const result = await conn.query(
        `UPDATE alerts SET status = 'active', resolved_at = NULL, acknowledged_at = NULL,
           acknowledged_by = NULL, reopen_count = reopen_count + 1,
           last_seen_at = ?, updated_at = ?, evidence = ?, diagnosis = ?
         WHERE id = ? AND status = 'resolved'`,
        [at, at, j(evidence), j(desired.diagnosis), op.id],
      );
      if (Number(result.affectedRows) === 1) {
        reopened += 1;
        await conn.query(
          'INSERT INTO alert_events (alert_id, at, from_status, to_status, actor, note) VALUES (?,?,?,?,?,?)',
          [op.id, at, 'resolved', 'active', 'system', event],
        );
      }
    } else if (op.op === 'touch') {
      await conn.query(
        'UPDATE alerts SET last_seen_at = ?, updated_at = ?, evidence = ?, diagnosis = ? WHERE id = ?',
        [at, at, j(evidence), j(desired.diagnosis), op.id],
      );
      touched += 1;
    } else if (op.op === 'resolve') {
      const result = await conn.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ?, evidence = ?, diagnosis = ?
         WHERE id = ? AND status <> 'resolved'`,
        [at, at, j(evidence), j(desired.diagnosis), op.id],
      );
      if (Number(result.affectedRows) === 1) {
        resolved += 1;
        await conn.query(
          'INSERT INTO alert_events (alert_id, at, from_status, to_status, actor, note) VALUES (?,?,?,?,?,?)',
          [op.id, at, statusById.get(Number(op.id)) ?? null, 'resolved', 'system', event],
        );
      }
    }
  }
  return { created, reopened, touched, resolved };
}

// Input korelasi: temuan aktif siklus ini plus alert terbuka yang tidak resolved dan tidak
// dinilai ulang siklus ini (alert yang di-hold tetap dihitung). Satu entri per dedup_key.
export function correlationInputOf(desired, openAlerts) {
  const evaluated = new Set(desired.map((d) => d.dedup_key));
  const stillOpen = openAlerts.filter((a) => a.status !== 'resolved' && !evaluated.has(a.dedup_key));
  return [...desired.filter((d) => d.active), ...stillOpen].map((a) => ({
    rule_id: a.rule_id,
    device_id: a.device_id ?? null,
    target: a.target ?? null,
    severity: ALERT_RULES[a.rule_id]?.severity ?? 'info',
  }));
}

// Satu putaran evaluasi. Mengembalikan ringkasan untuk log; tidak melempar.
export async function runAlertEval(pool, { atMs = Date.now() } = {}) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [lock] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
    locked = Number(lock.got) === 1;
    if (!locked) return { skipped: true };

    const state = await loadState(conn, atMs);
    const inputs = shapeInputs(state, atMs);
    // Sekali per siklus: snapshot client terakhir tiap AP (untuk memisahkan roaming dari hilang).
    const clientSnapshots = latestClientSnapshots(inputs, atMs);
    const openAlerts = state.openRows.map((row) => ({
      id: Number(row.id),
      rule_id: row.rule_id,
      status: row.status,
      device_id: row.device_id === null ? null : Number(row.device_id),
      target: row.target,
      dedup_key: row.dedup_key,
      first_seen_at: iso(row.first_seen_at),
      last_seen_at: iso(row.last_seen_at),
      resolved_at: iso(row.resolved_at),
      evidence: jsonOf(row.evidence) ?? {},
      diagnosis: jsonOf(row.diagnosis),
    }));
    // openAlerts memuat baris resolved (untuk reopen di planAlertChanges). Baris resolved
    // TIDAK boleh dianggap terbuka oleh rule maupun korelasi: dulu incident.ap tertahan
    // karena alert client yang sudah resolved masih dihitung sebagai indikator.
    const liveAlerts = openAlerts.filter((a) => a.status !== 'resolved');

    const findings = [];
    const deviceSummaries = [];

    for (const device of state.devices) {
      const id = Number(device.id);
      // Perangkat tanpa sampel dalam jendela tetap dievaluasi: rule berbasis ping
      // harus bisa menyimpulkan "tidak ada data".
      const input = inputs.get(id) ?? { ping: null, pingHistory: [], system: null, systemHistory: [], systemSamples: [], events: [], points: [] };
      const byKey = new Map(liveAlerts.filter((a) => a.device_id === id).map((a) => [a.dedup_key, a]));
      const deviceResult = evaluateDeviceRules({
        atMs,
        device: { id, name: device.name },
        metrics: {
          ping: { observed_at: input.ping?.observed_at ?? null, reachable: input.ping?.reachable ?? null, code: input.ping?.code ?? null, history: input.pingHistory },
          system: { observed_at: input.system?.observed_at ?? null, collection_status: input.system?.collection_status ?? null, history: input.systemHistory },
          systemSamples: input.systemSamples,
        },
        events: input.events,
        alerts: byKey,
      });
      for (const finding of deviceResult.findings) findings.push({ ...finding, device_id: id });

      // Client hanya dinilai bila AP sendiri dapat diverifikasi: metrik sistem segar
      // dan sesi SSH terakhir sukses.
      const systemAgeMs = input.system ? atMs - Date.parse(input.system.observed_at) : null;
      const latestSsh = input.systemSamples[input.systemSamples.length - 1]?.ssh ?? null;
      const apEvaluable = systemAgeMs !== null && systemAgeMs <= ALERT.maxDataAgeMs.metric && latestSsh?.status === 'ok';
      const lastSnapshot = input.points[input.points.length - 1] ?? null;
      const alertMacs = new Set(liveAlerts.filter((a) => a.device_id === id && a.target).map((a) => a.target));
      const healthyClients = lastSnapshot ? (lastSnapshot.clients ?? []).filter((c) => !alertMacs.has(c.mac)).length : null;
      const clientFindings = evaluateClientRules({
        atMs,
        deviceId: id,
        points: input.points,
        alerts: byKey,
        apEvaluable,
        healthyClients,
        seenElsewhere: elsewhereFor(clientSnapshots, id),
      });
      for (const finding of clientFindings) findings.push({ ...finding, device_id: id });

      deviceSummaries.push({
        id,
        stale: systemAgeMs === null || systemAgeMs > ALERT.maxDataAgeMs.metric,
        client_count: input.system?.client_count ?? null,
      });
    }

    const desired = findings.map((item) => ({ ...item, dedup_key: alertDedupKey(item) }));

    const correlationInput = correlationInputOf(desired, liveAlerts);
    const heartbeatAtMs = state.heartbeatAtMs;
    const correlations = correlateAlerts({
      atMs,
      alerts: correlationInput,
      devices: deviceSummaries,
      collectorAgeMs: heartbeatAtMs === null ? null : atMs - heartbeatAtMs,
    });
    for (const item of correlations) desired.push({ ...item, dedup_key: alertDedupKey(item) });

    // Korelasi tidak dihitung ulang dari nol: bila insiden yang masih terbuka tidak
    // lagi terdeteksi siklus ini, insiden itu ditutup — bukan menggantung selamanya.
    const correlationKeys = new Set(correlations.map((item) => alertDedupKey(item)));
    for (const row of liveAlerts) {
      const isCorrelation = String(row.rule_id).startsWith('incident.') || String(row.rule_id).startsWith('correlation.');
      if (!isCorrelation || correlationKeys.has(row.dedup_key)) continue;
      desired.push({
        rule_id: row.rule_id,
        device_id: row.device_id,
        target: row.target,
        severity: ALERT_RULES[row.rule_id]?.severity ?? 'info',
        active: false,
        since: null,
        evidence: row.evidence,
        diagnosis: row.diagnosis,
        dedup_key: row.dedup_key,
      });
    }

    // Kondisi collector bermasalah menahan alert per-AP: bukan bukti AP mati.
    const collectorActive = desired.some((d) => d.active && d.rule_id === 'incident.collector');
    const kept = collectorActive
      ? desired.filter((d) => !['ap.unreachable', 'ap.metrics.stale', 'ap.collector_stalled', 'ap.unverified'].includes(d.rule_id) && !String(d.rule_id).startsWith('client.'))
      : desired;

    const ops = planAlertChanges(kept, openAlerts, { at: new Date(atMs).toISOString() });
    await conn.beginTransaction();
    const counts = await applyOps(conn, ops, atMs, new Map(openAlerts.map((row) => [row.id, row.status])));
    await conn.commit();
    return { skipped: false, ...counts, suppressed: collectorActive ? desired.length - kept.length : 0 };
  } catch (err) {
    await conn.rollback().catch(() => {});
    log.error({ event: 'alert_eval_failed', code: err?.message ?? 'unknown' });
    return { skipped: false, error: true };
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    conn.release();
  }
}

// Jalankan berkala. Timer di-unref: job tidak menahan proses tetap hidup.
export function startAlertJob(pool, { intervalMs = ALERT.evalIntervalMs } = {}) {
  let lastPruneAt = 0;

  async function tick() {
    const started = Date.now();
    const result = await runAlertEval(pool, { atMs: started });
    if (result.skipped || result.error) return;
    if (result.created || result.reopened || result.resolved) {
      log.info({
        event: 'alert_eval',
        status: `created=${result.created} reopened=${result.reopened} resolved=${result.resolved} touched=${result.touched}`,
        durationMs: Date.now() - started,
      });
    }
    if (started - lastPruneAt >= PRUNE_MS) {
      lastPruneAt = started;
      await prune(pool, 'clients', started - ALERT.retentionMs.clients);
      await prune(pool, 'metrics', started - ALERT.retentionMs.metrics);
      await prune(pool, 'alerts', started - ALERT.retentionMs.alerts);
    }
  }

  const timer = setInterval(() => {
    tick().catch((err) => log.error({ event: 'alert_eval_failed', code: err?.message ?? 'unknown' }));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
