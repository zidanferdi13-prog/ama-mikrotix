// Realtime §7: emit hanya untuk data yang SUDAH commit di DB.
// ponytail: poll selisih dari DB tiap 5s. Cukup untuk 3 AP, satu proses, tanpa Redis/bus.
// Ganti ke LISTEN/NOTIFY atau message bus bila perlu latensi <1s atau multi-node.

const POLL_MS = 5_000;

export function emitterFor(io) {
  return (event, payload) => io.emit(event, payload);
}

export function startEventPoller({ pool, emit, intervalMs = POLL_MS }) {
  let lastEventId = null;
  // Kursor alert: (updated_at, id) — dua alert dalam milidetik yang sama tetap terbaca.
  let lastAlertAt = new Date(0);
  let lastAlertId = 0;
  let stopped = false;

  async function init() {
    const [ev] = await pool.query('SELECT COALESCE(MAX(id),0) AS id FROM monitoring_events');
    const [mt] = await pool.query('SELECT COALESCE(MAX(id),0) AS id FROM device_metrics');
    lastEventId = Number(ev.id);
    lastMetricId = Number(mt.id);
    try {
      const [al] = await pool.query('SELECT id, updated_at FROM alerts ORDER BY updated_at DESC, id DESC LIMIT 1');
      if (al) {
        lastAlertAt = al.updated_at;
        lastAlertId = Number(al.id);
      }
    } catch {
      // Migrasi 005 belum jalan → realtime alert tidak aktif, sisanya tetap jalan.
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const events = await pool.query(
        'SELECT id, device_id, type, started_at, status, detail FROM monitoring_events WHERE id > ? ORDER BY id ASC',
        [lastEventId],
      );
      for (const event of events) {
        lastEventId = Number(event.id);
        // device.status.changed dan alert.created punya identitas + timestamp untuk refetch.
        emit('device.status.changed', {
          device_id: event.device_id,
          type: event.type,
          at: event.started_at,
          status: event.status,
          detail: event.detail,
        });
        if (event.status === 'aktif') {
          emit('alert.created', { device_id: event.device_id, at: event.started_at, detail: event.detail });
        }
      }

      if (events.length > 0) {
        const devices = await pool.query(
          'SELECT id, last_ping_attempt_at, system_last_valid_at FROM devices WHERE id IN (?)',
          [events.map((e) => e.device_id)],
        );
        for (const device of devices) {
          emit('metrics.updated', {
            device_id: device.id,
            at: device.system_last_valid_at ?? device.last_ping_attempt_at,
          });
        }
      }

      // Alert dari rule engine: tabel baru, jadi kegagalannya diisolasi.
      try {
        const alerts = await pool.query(
          `SELECT id, rule_id, status, device_id, updated_at FROM alerts
           WHERE updated_at > ? OR (updated_at = ? AND id > ?)
           ORDER BY updated_at ASC, id ASC LIMIT 50`,
          [lastAlertAt, lastAlertAt, lastAlertId],
        );
        for (const row of alerts) {
          lastAlertAt = row.updated_at;
          lastAlertId = Number(row.id);
          emit('alert.updated', {
            id: Number(row.id),
            rule_id: row.rule_id,
            status: row.status,
            device_id: row.device_id === null ? null : Number(row.device_id),
            at: row.updated_at,
          });
        }
      } catch {
        // Tabel belum ada / DB gagal: jangan emit apa pun.
      }
    } catch {
      // DB gagal → cukup tidak emit; jangan mengaku data sudah tersimpan.
    }
  }

  const timer = setInterval(poll, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  init().catch(() => {});

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
