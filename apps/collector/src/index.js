// Entrypoint collector: jadwalkan ping + SSH sistem per AP aktif di tabel devices.
// Daftar AP disegarkan berkala dari DB (DEVICE_REFRESH_MS) sehingga tambah,
// nonaktifkan, atau hapus dari dashboard berlaku tanpa restart collector.
import { COLLECT_INTERVAL_MS, DEVICE_REFRESH_MS, KINDS, clientSnapshot, normalizeSystemSample, parseDeviceIdentity } from '@ama/shared';
import { listCollectorDevices } from '@ama/db';
import { createScheduler } from './scheduler.js';
import { collectPing } from './ping.js';
import { collectSystem } from './ssh.js';
import { persistClients, persistIdentity, persistPing, persistSystem, writeHeartbeat } from './persist.js';
import { describeSecretSource } from './secrets.js';
import { startAlertJob } from './alerts-job.js';
import { log } from './logger.js';

const HEARTBEAT_MS = 30_000;

export async function startCollector({ pool, refreshMs = DEVICE_REFRESH_MS } = {}) {
  const devices = new Map(); // id → AP aktif; pekerjaan membacanya saat berjalan agar ip/username baru langsung terpakai
  const jobs = new Map(); // `${id}:${kind}` → pekerjaan

  function createJob(deviceId, kind) {
    if (kind === KINDS.ping) {
      return {
        deviceId,
        kind,
        intervalMs: COLLECT_INTERVAL_MS.ping,
        run: async () => {
          const device = devices.get(deviceId);
          if (!device) return null; // AP dinonaktifkan/dihapus saat pekerjaan antre
          const started = Date.now();
          const sample = await collectPing(deviceId, device.ip);
          const result = await persistPing(pool, sample);
          log.info({
            event: 'collect',
            deviceId,
            kind,
            status: sample.collection_status,
            code: sample.code,
            durationMs: Date.now() - started,
          });
          return result;
        },
      };
    }

    return {
      deviceId,
      kind,
      intervalMs: COLLECT_INTERVAL_MS.system,
      run: async () => {
        const device = devices.get(deviceId);
        if (!device) return null;
        const started = Date.now();
        const { observedAt, outputs, connectError } = await collectSystem(deviceId, device);
        const sample = normalizeSystemSample({ deviceId, observedAt, outputs });
        // Status SSH disimpan per sampel supaya alert bisa membedakan "AP mati" dari
        // "SSH gagal" (§5.1). JSON, tanpa perubahan skema.
        sample.metric_status.ssh = { status: connectError ? 'error' : 'ok', code: connectError };
        const result = await persistSystem(pool, sample);
        // Snapshot client terpisah dari transaksi metrik (migrasi 005 mungkin belum ada).
        const snapshot = result.committed ? clientSnapshot(outputs.mcaDump) : { ok: false };
        if (snapshot.ok) await persistClients(pool, deviceId, observedAt, snapshot.clients);
        // Identitas (vendor/model/firmware) dari mca-dump yang sama; tanpa data → tidak disentuh.
        const identity = result.committed && !connectError ? parseDeviceIdentity(outputs.mcaDump) : null;
        if (identity && (await persistIdentity(pool, deviceId, identity))) {
          log.info({ event: 'identity_verified', deviceId, vendor: identity.vendor, model: identity.model, firmware: identity.firmware });
        }
        log.info({
          event: 'collect',
          deviceId,
          kind,
          status: sample.collection_status,
          code: connectError ?? undefined,
          durationMs: Date.now() - started,
        });
        return result;
      },
    };
  }

  // Selaraskan daftar pekerjaan dengan AP aktif; jadwal pekerjaan lama dipertahankan.
  function ensureJobs(list) {
    const wanted = new Set();
    for (const device of list) {
      devices.set(device.id, device);
      let added = false;
      for (const kind of [KINDS.ping, KINDS.system]) {
        const key = `${device.id}:${kind}`;
        wanted.add(key);
        if (jobs.has(key)) continue;
        jobs.set(key, createJob(device.id, kind));
        added = true;
      }
      if (added) {
        log.info({ event: 'device_registered', deviceId: device.id, status: `secret:${describeSecretSource(device.id)}` });
      }
    }

    for (const [key, job] of [...jobs]) {
      if (wanted.has(key)) continue;
      jobs.delete(key);
      log.info({ event: 'device_unregistered', deviceId: job.deviceId, kind: job.kind, status: 'ok' });
    }
    for (const id of [...devices.keys()]) {
      if (![...jobs.keys()].some((key) => key.startsWith(`${id}:`))) devices.delete(id);
    }

    scheduler.setJobs([...jobs.values()]);
  }

  const scheduler = createScheduler({
    jobs: [],
    onError: ({ job, err }) => {
      log.error({ event: 'job_failed', deviceId: job.deviceId, kind: job.kind, code: err?.message ?? 'unknown' });
    },
  });

  async function refreshDevices() {
    try {
      ensureJobs(await listCollectorDevices(pool));
    } catch (err) {
      // DB tidak tersedia: pertahankan daftar yang ada, jangan hentikan collector.
      log.error({ event: 'device_refresh_failed', code: err?.message ?? 'unknown' });
    }
  }

  await refreshDevices();
  scheduler.start();

  const refreshTimer = setInterval(refreshDevices, refreshMs);
  const heartbeat = setInterval(() => writeHeartbeat(pool), HEARTBEAT_MS);
  // Evaluasi alert terpisah dari koleksi: kegagalannya tidak menghentikan pengumpulan.
  const alertJob = startAlertJob(pool);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    scheduler,
    refreshDevices,
    alertJob,
    stop() {
      scheduler.stop();
      clearInterval(refreshTimer);
      clearInterval(heartbeat);
      alertJob.stop();
    },
  };
}

export { KINDS };
