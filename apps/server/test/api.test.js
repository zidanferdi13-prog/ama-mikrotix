import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.AMA_JWT_SECRET = 'test-secret';
process.env.AMA_AUTH_USER = 'operator';
process.env.AMA_AUTH_PASSWORD = 'rahasia';

const { createApp } = await import('../src/app.js');
const { parseRange } = await import('../src/queries.js');

// Stub pool: cukup untuk menguji routing/validasi tanpa MariaDB nyata.
function stubPool() {
  return {
    query: async (sql, params) => {
      if (/SELECT 1/.test(sql)) return [{ '1': 1 }];
      if (/collector_heartbeat/.test(sql)) return [];
      if (/FROM devices ORDER BY/.test(sql)) return [];
      if (/FROM devices WHERE id/.test(sql)) return [];
      if (/FROM monitoring_events/.test(sql)) return [];
      if (/FROM device_metrics/.test(sql)) return [];
      return [];
    },
  };
}

async function withServer(run) {
  const app = createApp({ pool: stubPool(), allowedOrigin: 'http://localhost:5173' });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function getSetCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean);
}

test('tanpa autentikasi → 401 pada endpoint operasional', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices`);
    assert.equal(res.status, 401);
  });
});

test('login salah → 401 tanpa membocorkan rincian', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'salah' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_credentials' });
  });
});

test('login benar → cookie HttpOnly, lalu akses endpoint berhasil', async () => {
  await withServer(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'rahasia' }),
    });
    assert.equal(login.status, 200);
    const cookie = getSetCookie(login).find((c) => c.startsWith('ama_session='));
    assert.ok(cookie, 'cookie sesi harus diset');
    assert.match(cookie, /HttpOnly/i);

    const devices = await fetch(`${base}/api/devices`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(devices.status, 200);
  });
});

test('daftar alert lama (dipakai Ringkasan) tetap melayani dan menolak limit tidak valid', async () => {
  await withServer(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'rahasia' }),
    });
    const cookie = getSetCookie(login).find((c) => c.startsWith('ama_session=')).split(';')[0];

    const res = await fetch(`${base}/api/alerts?limit=5`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { alerts: [] });

    const bad = await fetch(`${base}/api/alerts?limit=0`, { headers: { cookie } });
    assert.equal(bad.status, 400);
  });
});

test('id tidak ditemukan → 404; id salah format → 400', async () => {
  await withServer(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'rahasia' }),
    });
    const cookie = getSetCookie(login).find((c) => c.startsWith('ama_session=')).split(';')[0];

    const bad = await fetch(`${base}/api/devices/abc`, { headers: { cookie } });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${base}/api/devices/999`, { headers: { cookie } });
    assert.equal(missing.status, 404);
  });
});

test('health mengembalikan 503 saat collector belum heartbeat', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.collector.code, 'no_heartbeat');
  });
});

test('rentang histori: default 1 jam, tolak >24 jam dan rentang terbalik', () => {
  const now = Date.parse('2026-10-15T08:00:00Z');
  const ok = parseRange({}, now);
  assert.equal(now - Date.parse(ok.from), 60 * 60 * 1000);

  const tooLarge = parseRange({ from: '2026-10-01T00:00:00Z', to: '2026-10-15T08:00:00Z' }, now);
  assert.equal(tooLarge.error, 'range_too_large');

  const reversed = parseRange({ from: '2026-10-15T09:00:00Z', to: '2026-10-15T08:00:00Z' }, now);
  assert.equal(reversed.error, 'invalid_range');

  const bad = parseRange({ from: 'bukan-tanggal' }, now);
  assert.equal(bad.error, 'invalid_range');
});
