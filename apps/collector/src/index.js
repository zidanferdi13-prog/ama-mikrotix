// Entrypoint collector: jadwalkan ping + SSH sistem per AP terdaftar.
import { COLLECT_INTERVAL_MS, KINDS, normalizeSystemSample } from '@ama/shared';
import { loadCollectorConfig } from './config.js';
import { createScheduler } from './scheduler.js';
import { collectPing } from './ping.js';
import { collectSystem } from './ssh.js';
import { persistPing, persistSystem, writeHeartbeat } from './persist.js';
import { describeSecretSource } from './secrets.js';
import { log } from './logger.js';

const HEARTBEAT_MS = 30_000;

export async function startCollector({ pool, configPath } = {}) {
  const config = loadCollectorConfig(configPath);
  const jobs = [];

  for (const device of config.devices) {
    jobs.push({
      deviceId: device.id,
      kind: KINDS.ping,
      intervalMs: device.pingIntervalMs ?? COLLECT_INTERVAL_MS.ping,
      run: async () => {
        const started = Date.now();
        const sample = await collectPing(device.id, device.ip);
        const result = await persistPing(pool, sample);
        log.info({
          event: 'collect',
          deviceId: device.id,
          kind: KINDS.ping,
          status: sample.collection_status,
          code: sample.code,
          durationMs: Date.now() - started,
        });
        return result;
      },
    });

    jobs.push({
      deviceId: device.id,
      kind: KINDS.system,
      intervalMs: device.systemIntervalMs ?? COLLECT_INTERVAL_MS.system,
      run: async () => {
        const started = Date.now();
        const { observedAt, outputs, connectError } = await collectSystem(device.id, device);
        const sample = normalizeSystemSample({ deviceId: device.id, observedAt, outputs });
        const result = await persistSystem(pool, sample);
        log.info({
          event: 'collect',
          deviceId: device.id,
          kind: KINDS.system,
          status: sample.collection_status,
          code: connectError ?? undefined,
          durationMs: Date.now() - started,
        });
        return result;
      },
    });
  }

  const scheduler = createScheduler({
    jobs,
    onError: ({ job, err }) => {
      log.error({ event: 'job_failed', deviceId: job.deviceId, kind: job.kind, code: err?.message ?? 'unknown' });
    },
  });
  scheduler.start();

  const heartbeat = setInterval(() => writeHeartbeat(pool), HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  for (const device of config.devices) {
    log.info({ event: 'device_registered', deviceId: device.id, status: `secret:${describeSecretSource(device.id)}` });
  }

  return {
    scheduler,
    stop() {
      scheduler.stop();
      clearInterval(heartbeat);
    },
  };
}

export { KINDS };
