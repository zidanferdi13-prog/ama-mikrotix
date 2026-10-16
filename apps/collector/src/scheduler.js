// Scheduler: interval per AP+kind, concurrency terbatas, tanpa overlap.
// Pekerjaan yang belum selesai melewati slot berikutnya (tidak menumpuk antrean).
import { CONCURRENCY } from '@ama/shared';

export function createScheduler({ jobs, concurrency = CONCURRENCY, tickMs = 1000, now = () => Date.now(), onError = null }) {
  const running = new Set(); // key `${deviceId}:${kind}`
  const inflight = { ping: 0, system: 0 };
  let nextDue = jobs.map((job) => now() + job.intervalMs);
  let timer = null;

  function canStart(kind) {
    const limit = concurrency[kind] ?? 1;
    return inflight[kind] < limit;
  }

  async function maybeRun() {
    const ts = now();
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      const key = `${job.deviceId}:${job.kind}`;

      if (ts < nextDue[i]) continue;
      // Overlap: lewati slot bila pekerjaan sama masih aktif.
      if (running.has(key)) continue;
      // Concurrency per kind penuh: coba lagi tick berikut.
      if (!canStart(job.kind)) continue;
      // Belum selesai → jadwalkan ulang dari sekarang, jangan menumpuk.
      nextDue[i] = ts + job.intervalMs;

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

  return {
    start() {
      if (timer) return;
      nextDue = jobs.map((job) => now() + job.intervalMs);
      timer = setInterval(maybeRun, tickMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Untuk pengujian.
    tick: maybeRun,
    isRunning: (deviceId, kind) => running.has(`${deviceId}:${kind}`),
  };
}
