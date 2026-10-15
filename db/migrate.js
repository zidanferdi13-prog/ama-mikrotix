// Jalankan migrasi + seed berurutan. Idempoten (CREATE IF NOT EXISTS / ON DUPLICATE KEY).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool } from '@ama/db';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

async function runDir(conn, dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // Buang komentar baris lalu pecah per statement.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await conn.query(statement);
    }
    process.stdout.write(`applied ${file}\n`);
  }
}

const pool = createPool();
const conn = await pool.getConnection();
try {
  await runDir(conn, join(root, 'db', 'migrations'));
  await runDir(conn, join(root, 'db', 'seed'));
} finally {
  conn.release();
  await pool.end();
}
