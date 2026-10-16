// Nilai di DB adalah UTC; proses dipaksa UTC agar pembacaan DATETIME tidak bergeser ke zona lokal.
process.env.TZ = 'UTC';

// Jalankan collector: node apps/collector/src/main.js
import { DEVICE_REFRESH_MS } from '@ama/shared';
import { createPool } from '@ama/db';
import { startCollector } from './index.js';
import { log } from './logger.js';

const pool = createPool();
const collector = await startCollector({ pool, refreshMs: Number(process.env.AMA_DEVICE_REFRESH_MS) || DEVICE_REFRESH_MS });

log.info({ event: 'collector_started', status: 'ok' });

async function shutdown() {
  collector.stop();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
