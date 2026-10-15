// Pool MariaDB akun aplikasi berhak minimum. Kredensial dari env, bukan repo.
import mariadb from 'mariadb';

export function dbConfigFromEnv(env = process.env) {
  return {
    host: env.AMA_DB_HOST ?? '127.0.0.1',
    port: Number(env.AMA_DB_PORT ?? 3306),
    user: env.AMA_DB_USER ?? 'ama_app',
    password: env.AMA_DB_PASSWORD ?? '',
    database: env.AMA_DB_NAME ?? 'ama_monitoring',
    connectionLimit: Number(env.AMA_DB_POOL ?? 5),
    timezone: 'Z',
    dateStrings: false,
  };
}

export function createPool(config = dbConfigFromEnv()) {
  return mariadb.createPool(config);
}

// Cek DB untuk /api/health.
export async function checkDb(pool) {
  try {
    await pool.query('SELECT 1');
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: 'db_unavailable' };
  }
}
