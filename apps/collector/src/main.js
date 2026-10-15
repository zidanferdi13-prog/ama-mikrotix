// Jalankan collector: node apps/collector/src/main.js
import { createPool } from '@ama/db';
import { startCollector } from './index.js';
import { log } from './logger.js';

const pool = createPool();
const collector = await startCollector({ pool });

log.info({ event: 'collector_started', status: 'ok' });

async function shutdown() {
  collector.stop();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
