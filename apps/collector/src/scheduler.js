// Scheduler: interval per AP+kind, concurrency terbatas, tanpa overlap.
// Pekerjaan yang belum selesai melewati slot berikutnya (tidak menumpuk antrean).
// Daftar pekerjaan bisa diganti saat berjalan (setJobs): AP yang baru ditambah
// dari dashboard mulai dikoleksi tanpa restart, yang dinonaktifkan berhenti.
import { CONCURRENCY } from '@ama/shared';

const keyOf = (job) => `${job.deviceId}:${job.kind}`;

export function createScheduler({ jobs, concurrency = CONCURRENCY, tickMs = 1000, now = () => Date.now(), onError = null }) {
  const running = new Set(); // key `${deviceId}:${kind}`
  const inflight = { ping: 0, system: 0 };
  let current = jobs;
  let due = new Map(); // key → waktu jalan berikutnya
  let timer = null;

  function canStart(kind) {
    const limit = concurrency[kind] ?? 1;
    return inflight[kind] < limit;
  }

  // Pertahankan jadwal pekerjaan yang sudah ada; yang baru mulai dari sekarang.
  function syncDue() {
    const next = new Map();
    for (const job of current) {
      const key = keyOf(job);
      next.set(key, due.get(key) ?? now() + job.intervalMs);
    }
    due = next;
  }

  async function maybeRun() {
    const ts = now();
    for (const job of current) {
      const key = keyOf(job);

      if (ts < (due.get(key) ?? 0)) continue;
      // Overlap: lewati slot bila pekerjaan sama masih aktif.
      if (running.has(key)) continue;
      // Concurrency per kind penuh: coba lagi tick berikut.
      if (!canStart(job.kind)) continue;
      // Belum selesai → jadwalkan ulang dari sekarang, jangan menumpuk.
      due.set(key, ts + job.intervalMs);

      running.add(key);
      inflight[job.kind] += 1;
      Promise.resolve()
        .then(() => job.run())
        .catch((err) => {
          // Kegagalan tak terduga tidak boleh hilang tanpa jejak.
          if (onError) onError({ job, err });
        })
        .finally(() => {
          running.delete(key);
          inflight[job.kind] -= 1;
        });
    }
  }

  syncDue();

  return {
    start() {
      if (timer) return;
      due = new Map();
      syncDue();
      timer = setInterval(maybeRun, tickMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    // Ganti daftar pekerjaan tanpa kehilangan jadwal pekerjaan yang sudah ada.
    setJobs(next) {
      current = next;
      syncDue();
    },
    // Untuk pengujian.
    tick: maybeRun,
    isRunning: (deviceId, kind) => running.has(`${deviceId}:${kind}`),
  };
}
