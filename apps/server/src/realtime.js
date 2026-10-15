// Realtime §7: emit hanya untuk data yang SUDAH commit di DB.
// ponytail: poll selisih dari DB tiap 5s. Cukup untuk 3 AP, satu proses, tanpa Redis/bus.
// Ganti ke LISTEN/NOTIFY atau message bus bila perlu latensi <1s atau multi-node.

const POLL_MS = 5_000;

export function emitterFor(io) {
  return (event, payload) => io.emit(event, payload);
}

export function startEventPoller({ pool, emit, intervalMs = POLL_MS }) {
  let lastEventId = null;
  let lastMetricId = null;
  let stopped = false;

  async function init() {
    const [ev] = await pool.query('SELECT COALESCE(MAX(id),0) AS id FROM monitoring_events');
    const [mt] = await pool.query('SELECT COALESCE(MAX(id),0) AS id FROM device_metrics');
    lastEventId = Number(ev.id);
    lastMetricId = Number(mt.id);
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
