// Uji perilaku konsumen API device: CRUD, validasi, rahasia, probe, summary.
// Stub pool + stub ssh2 — tanpa MariaDB/SSH nyata. Rahasia di berkas temporer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

process.env.AMA_JWT_SECRET = 'test-secret';
process.env.AMA_AUTH_USER = 'operator';
process.env.AMA_AUTH_PASSWORD = 'rahasia';
const SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'ama-secrets-')), 'secrets.json');
process.env.AMA_SECRETS_FILE = SECRETS_FILE;

const { createApp } = await import('../src/app.js');
const { probeHostKey } = await import('../src/ssh-probe.js');
const { listClients } = await import('../src/ssh-clients.js');

function writeSecrets(data) {
  writeFileSync(SECRETS_FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function readSecrets() {
  return JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
}

// Stub pool: penyimpanan device in-memory + pola SQL yang dikenali.
function createStubPool() {
  const devices = [];
  const history = new Set();
  const state = { seriesValue: null };
  let nextId = 1;

  const base = {
    identity_verified: 0,
    enabled: 1,
    notes: null,
    port: 22,
    username: null,
    vendor: null,
    model: null,
    firmware: null,
    host_key_fingerprint: null,
    secret_updated_at: null,
    reachable: 'unknown',
    ping_fail_count: 0,
    ping_ok_count: 0,
    last_ping_attempt_at: null,
    uptime_last_valid_at: null,
    load_last_valid_at: null,
    ram_last_valid_at: null,
    system_last_valid_at: null,
    last_collection_status: null,
  };

  function addDevice(partial = {}) {
    const device = { ...base, id: nextId++, name: `AP${nextId}`, ip: `10.0.0.${nextId}`, ...partial };
    devices.push(device);
    return device;
  }

  return {
    devices,
    history,
    state,
    addDevice,
    query: async (sql, params = []) => {
      if (/FROM devices ORDER BY name/.test(sql)) {
        return [...devices].sort((a, b) => a.name.localeCompare(b.name));
      }
      if (/^SELECT[\s\S]*FROM devices WHERE id = \?/.test(sql)) {
        return devices.filter((d) => d.id === Number(params[0]));
      }
      if (/FROM devices WHERE ip = \?/.test(sql)) {
        return devices.filter((d) => d.ip === params[0]).map((d) => ({ id: d.id }));
      }
      if (/INSERT INTO devices/.test(sql)) {
        const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
        const device = { ...base, id: nextId++ };
        cols.forEach((col, i) => {
          device[col] = params[i];
        });
        devices.push(device);
        return { insertId: device.id, affectedRows: 1 };
      }
      if (/UPDATE devices SET secret_updated_at = UTC_TIMESTAMP/.test(sql)) {
        const device = devices.find((d) => d.id === Number(params[0]));
        if (device) device.secret_updated_at = new Date();
        return { affectedRows: device ? 1 : 0 };
      }
      if (/UPDATE devices SET secret_updated_at = NULL/.test(sql)) {
        const device = devices.find((d) => d.id === Number(params[0]));
        if (device) device.secret_updated_at = null;
        return { affectedRows: device ? 1 : 0 };
      }
      if (/UPDATE devices SET/.test(sql)) {
        const setPart = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE'));
        const keys = setPart.split(',').map((part) => part.split('=')[0].trim());
        const device = devices.find((d) => d.id === Number(params[keys.length]));
        if (!device) return { affectedRows: 0 };
        keys.forEach((key, i) => {
          device[key] = params[i];
        });
        return { affectedRows: 1 };
      }
      if (/DELETE FROM devices WHERE id = \?/.test(sql)) {
        const index = devices.findIndex((d) => d.id === Number(params[0]));
        if (index === -1) return { affectedRows: 0 };
        devices.splice(index, 1);
        return { affectedRows: 1 };
      }
      if (/SELECT \(SELECT COUNT\(\*\) FROM device_metrics/.test(sql)) {
        return [{ metrics: history.has(Number(params[0])) ? 3 : 0, events: 0 }];
      }
      if (/FLOOR\(UNIX_TIMESTAMP/.test(sql)) {
        // Satu titik contoh di bucket pertama, bila uji menyemainya.
        if (!state.seriesValue) return [];
        const value = /kind = 'ping'/.test(sql) ? state.seriesValue.latency : state.seriesValue.ram;
        if (value === null) return [];
        const bucketSec = Number(params[0]);
        const first = Math.floor(Date.parse(`${params[1].replace(' ', 'T')}Z`) / 1000 / bucketSec);
        return [{ device_id: state.seriesValue.device_id, bucket: first, value }];
      }
      if (/^SELECT 1/.test(sql)) return [{ '1': 1 }];
      return [];
    },
  };
}

async function withServer(store, run, options = {}) {
  const app = createApp({ pool: store, allowedOrigin: 'http://localhost:5173', ...options });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'rahasia' }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ama_session='));
  return cookie.split(';')[0];
}

function call(base, cookie, path, { method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Tak satu pun kunci/nilai respons boleh memuat rahasia.
function assertNoSecret(value, secret, path = '$') {
  if (typeof value === 'string') {
    assert.notEqual(value, secret, `nilai rahasia muncul di ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecret(item, secret, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.doesNotMatch(key, /password/i, `kunci rahasia "${key}" muncul di ${path}`);
      assertNoSecret(item, secret, `${path}.${key}`);
    }
  }
}

test('tanpa sesi → 401 pada tiap endpoint tulis', async () => {
  await withServer(createStubPool(), async (base) => {
    const routes = [
      ['POST', '/api/devices'],
      ['PATCH', '/api/devices/1'],
      ['DELETE', '/api/devices/1'],
      ['DELETE', '/api/devices/1/secret'],
      ['POST', '/api/devices/probe'],
      ['GET', '/api/summary'],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
  });
});

test('validasi payload → 400 dengan kode field', async () => {
  await withServer(createStubPool(), async (base) => {
    const cookie = await login(base);
    const cases = [
      [{ name: '   ', ip: '192.168.5.10' }, 'name', 'required'],
      [{ name: 'AP', ip: '999.1.1.1' }, 'ip', 'invalid_ip'],
      [{ name: 'AP', ip: '192.168.5.10', port: 70000 }, 'port', 'invalid_port'],
      [{ name: 'AP', ip: '192.168.5.10', port: 'dua' }, 'port', 'invalid_type'],
      [{ name: 'AP', ip: '192.168.5.10', host_key_fingerprint: 'sha256:pendek' }, 'host_key_fingerprint', 'invalid_fingerprint'],
      [{ name: 'AP', ip: '192.168.5.10', password: 'x'.repeat(201) }, 'password', 'invalid_password'],
      [{ name: 'AP', ip: '192.168.5.10', enabled: 'ya' }, 'enabled', 'invalid_type'],
      [{ name: 'a'.repeat(121), ip: '192.168.5.10' }, 'name', 'too_long'],
      [{ name: 'AP', ip: '192.168.5.10', notes: 'n'.repeat(256) }, 'notes', 'too_long'],
    ];
    for (const [payload, field, code] of cases) {
      const res = await call(base, cookie, '/api/devices', { method: 'POST', body: payload });
      assert.equal(res.status, 400, JSON.stringify(payload));
      const body = await res.json();
      assert.equal(body.error, 'invalid_payload');
      assert.equal(body.fields[field], code, JSON.stringify(payload));
    }
  });
});

test('POST duplikat ip → 409 ip_taken; respons tanpa kunci rahasia', async () => {
  await withServer(createStubPool(), async (base) => {
    const cookie = await login(base);
    const first = await call(base, cookie, '/api/devices', {
      method: 'POST',
      body: { name: 'AP-1', ip: '192.168.5.228', password: 'rahasiaDevice' },
    });
    assert.equal(first.status, 201);
    const created = (await first.json()).device;
    assert.equal(created.name, 'AP-1');
    assert.equal(created.ip, '192.168.5.228');
    assert.equal(created.port, 22);
    assert.equal(created.enabled, true);
    assert.equal(created.has_secret, true);
    assert.ok(created.secret_updated_at, 'secret_updated_at terisi setelah password disimpan');
    assert.equal(statSync(SECRETS_FILE).mode & 0o777, 0o600, 'hasil akhir berkas rahasia mode 600');
    assertNoSecret(created, 'rahasiaDevice');

    const dup = await call(base, cookie, '/api/devices', {
      method: 'POST',
      body: { name: 'AP-2', ip: '192.168.5.228' },
    });
    assert.equal(dup.status, 409);
    assert.deepEqual(await dup.json(), { error: 'ip_taken' });
  });
});

test('PATCH tanpa password tidak menyentuh berkas rahasia; PATCH dengan password menulis entri', async () => {
  await withServer(createStubPool(), async (base, store) => {
    const cookie = await login(base);
    const device = store.addDevice({ name: 'AP-A', ip: '192.168.5.226' });
    writeSecrets({ [device.id]: 'lama' });
    const before = readFileSync(SECRETS_FILE, 'utf8');

    // Tanpa password dan dengan password '' → berkas tidak berubah.
    for (const body of [{ name: 'AP-A2' }, { name: 'AP-A3', password: '' }]) {
      const res = await call(base, cookie, `/api/devices/${device.id}`, { method: 'PATCH', body });
      assert.equal(res.status, 200);
      assert.equal(readFileSync(SECRETS_FILE, 'utf8'), before, 'berkas rahasia tidak boleh berubah');
    }

    const updated = await call(base, cookie, `/api/devices/${device.id}`, {
      method: 'PATCH',
      body: { notes: 'catatan', password: 'baru' },
    });
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.equal(body.device.notes, 'catatan');
    assert.equal(body.device.has_secret, true);
    assert.equal(readSecrets()[device.id], 'baru');
    assert.equal(statSync(SECRETS_FILE).mode & 0o777, 0o600, 'berkas rahasia tetap mode 600');
    assert.deepEqual(readdirSync(dirname(SECRETS_FILE)), ['secrets.json'], 'tak ada berkas sementara tertinggal');
    assertNoSecret(body, 'baru');

    // PATCH ke ip milik device lain → 409; id tak dikenal → 404.
    store.addDevice({ name: 'AP-B', ip: '192.168.5.227' });
    const clash = await call(base, cookie, `/api/devices/${device.id}`, {
      method: 'PATCH',
      body: { ip: '192.168.5.227' },
    });
    assert.equal(clash.status, 409);
    assert.deepEqual(await clash.json(), { error: 'ip_taken' });

    for (const id of ['999', 'abc']) {
      const unknown = await call(base, cookie, `/api/devices/${id}`, { method: 'PATCH', body: { name: 'AP-Z' } });
      assert.equal(unknown.status, 404, `PATCH ${id}`);
      assert.deepEqual(await unknown.json(), { error: 'not_found' });
    }
  });
});

test('device berhistori tidak bisa dihapus; device bersih terhapus + entri rahasia hilang', async () => {
  await withServer(createStubPool(), async (base, store) => {
    const cookie = await login(base);
    const withHistory = store.addDevice({ name: 'AP-H', ip: '192.168.5.228' });
    const clean = store.addDevice({ name: 'AP-C', ip: '192.168.5.120' });
    store.history.add(withHistory.id);
    writeSecrets({ [withHistory.id]: 'lama', [clean.id]: 'lama' });

    const blocked = await call(base, cookie, `/api/devices/${withHistory.id}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: 'device_has_history' });
    assert.ok(store.devices.some((d) => d.id === withHistory.id), 'device berhistori harus tetap ada');
    assert.equal(readSecrets()[withHistory.id], 'lama');

    const removed = await call(base, cookie, `/api/devices/${clean.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.ok(!store.devices.some((d) => d.id === clean.id));
    assert.equal(readSecrets()[clean.id], undefined);
    assert.equal(readSecrets()[withHistory.id], 'lama');
  });
});

test('DELETE /secret menghapus entri; tanpa entri → 204; device tidak ada → 404', async () => {
  await withServer(createStubPool(), async (base, store) => {
    const cookie = await login(base);
    const device = store.addDevice({ name: 'AP-S', ip: '192.168.5.226' });
    writeSecrets({ [device.id]: 'lama' });

    const missing = await call(base, cookie, '/api/devices/abc/secret', { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const res = await call(base, cookie, `/api/devices/${device.id}/secret`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(readSecrets(), {});

    // Berulang: entri sudah hilang tapi device masih ada → tetap 204 (idempoten).
    const again = await call(base, cookie, `/api/devices/${device.id}/secret`, { method: 'DELETE' });
    assert.equal(again.status, 204);

    const unknown = await call(base, cookie, '/api/devices/999/secret', { method: 'DELETE' });
    assert.equal(unknown.status, 404, 'device tidak ada → 404');
  });
});

test('log tulis tidak memuat nilai rahasia', async () => {
  await withServer(createStubPool(), async (base, store) => {
    const cookie = await login(base);
    const device = store.addDevice({ name: 'AP-L', ip: '192.168.5.228' });
    const lines = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      lines.push(String(chunk));
      return original(chunk, ...rest);
    };
    try {
      const res = await call(base, cookie, `/api/devices/${device.id}`, {
        method: 'PATCH',
        body: { password: 'rahasiaLog' },
      });
      assert.equal(res.status, 200);
    } finally {
      process.stdout.write = original;
    }
    const joined = lines.join('');
    assert.doesNotMatch(joined, /rahasiaLog/, 'nilai rahasia tidak boleh masuk log');
    assert.match(joined, /device_secret_set/, 'event log tetap tercatat');
  });
});

test('probe: sukses → 200 fingerprint; gagal → 502 + code', async () => {
  const store = createStubPool();
  const payload = { ip: '192.168.5.228', port: 22, username: 'monitor', password: 'rahasiaProbe' };
  const fingerprint = `sha256:${'A'.repeat(43)}=`;

  await withServer(store, async (base) => {
    const cookie = await login(base);

    const bad = await call(base, cookie, '/api/devices/probe', { method: 'POST', body: { ip: 'bukan-ip' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_payload');

    const ok = await call(base, cookie, '/api/devices/probe', { method: 'POST', body: payload });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body, { fingerprint });
    assertNoSecret(body, 'rahasiaProbe');
  }, { probe: async () => ({ ok: true, fingerprint }) });

  await withServer(store, async (base) => {
    const cookie = await login(base);
    const failed = await call(base, cookie, '/api/devices/probe', { method: 'POST', body: payload });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'probe_failed', code: 'auth_failed' });
  }, { probe: async () => ({ ok: false, code: 'auth_failed' }) });
});

test('probeHostKey: fingerprint sha256, pemetaan kode error, koneksi selalu ditutup', async () => {
  function fakeClient({ fail } = {}) {
    const client = new EventEmitter();
    client.closed = 0;
    client.end = () => { client.closed += 1; };
    client.destroy = () => { client.closed += 1; };
    client.connect = (config) => {
      client.config = config;
      setImmediate(() => {
        if (fail) {
          const err = new Error('gagal');
          err.level = fail.level;
          err.code = fail.code;
          client.emit('error', err);
          return;
        }
        client.emit('ready');
      });
    };
    return client;
  }

  const okClient = fakeClient();
  okClient.connect = (config) => {
    okClient.config = config;
    setImmediate(() => {
      config.hostVerifier(Buffer.from('host-key-bytes'));
      okClient.emit('ready');
    });
  };
  const ok = await probeHostKey(
    { ip: '192.168.5.228', port: 22, username: 'monitor', password: 'rahasiaProbe' },
    { Client: function StubClient() { return okClient; } },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.fingerprint, `sha256:${createHash('sha256').update(Buffer.from('host-key-bytes')).digest('base64')}`);
  assert.match(ok.fingerprint, /^sha256:[A-Za-z0-9+/]{43}=$/);
  assert.equal(okClient.config.password, 'rahasiaProbe');
  assert.equal(okClient.closed, 2, 'end + destroy dipanggil di finally');

  const cases = [
    [{ level: 'client-authentication' }, 'auth_failed'],
    [{ level: 'client-socket' }, 'connect_failed'],
    [{ code: 'timeout' }, 'timeout'],
  ];
  for (const [fail, code] of cases) {
    const client = fakeClient({ fail });
    const result = await probeHostKey(
      { ip: '192.168.5.228', password: 'rahasiaProbe' },
      { Client: function StubClient() { return client; } },
    );
    assert.deepEqual(result, { ok: false, code });
    assert.equal(client.closed, 2, 'end + destroy dipanggil di finally');
  }

  // Server tidak pernah ready → timer sesi memutus percobaan.
  const hanging = fakeClient();
  hanging.connect = () => {};
  const timeout = await probeHostKey(
    { ip: '192.168.5.228', password: 'rahasiaProbe' },
    { Client: function StubClient() { return hanging; }, sessionTimeoutMs: 20 },
  );
  assert.deepEqual(timeout, { ok: false, code: 'timeout' });
  assert.equal(hanging.closed, 2);
});

test('GET /api/summary: 60 titik per seri, slot kosong null, counts dari device', async () => {
  const store = createStubPool();
  store.addDevice({ name: 'AP-U', ip: '192.168.5.228', reachable: 'up' });
  store.addDevice({ name: 'AP-D', ip: '192.168.5.226', reachable: 'down' });
  store.state.seriesValue = { device_id: 1, latency: 12.5, ram: 30 };

  await withServer(store, async (base) => {
    const cookie = await login(base);
    const res = await call(base, cookie, '/api/summary?range=24h');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bucket_ms, 24 * 60 * 1000);
    assert.equal(body.counts.total, 2);
    assert.equal(body.counts.up, 1);
    assert.equal(body.counts.down, 1);
    assert.equal(body.devices.length, 2);
    for (const device of body.devices) {
      assert.equal(device.series.latency.length, 60);
      assert.equal(device.series.ram.length, 60);
    }
    const sampled = body.devices.find((d) => d.id === 1);
    assert.equal(sampled.series.latency[0], 12.5);
    assert.equal(sampled.series.latency[1], null);
    assert.equal(sampled.series.ram[0], 30);
    assert.equal(sampled.series.ram[1], null);
    assertNoSecret(body, 'rahasia');

    const bad = await call(base, cookie, '/api/summary?range=7h');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_range' });
  });
});

test('GET /api/devices & /:id memuat field kontrak', async () => {
  const store = createStubPool();
  const device = store.addDevice({ name: 'AP-X', ip: '192.168.5.228', username: 'monitor', notes: 'n' });
  writeSecrets({ [device.id]: 'lama' });

  await withServer(store, async (base) => {
    const cookie = await login(base);
    const list = await (await call(base, cookie, '/api/devices')).json();
    for (const key of ['port', 'username', 'host_key_fingerprint', 'enabled', 'notes', 'has_secret', 'secret_updated_at', 'collection_status']) {
      assert.ok(key in list.devices[0], `kunci ${key} harus ada`);
    }
    assert.equal(list.devices[0].has_secret, true);

    const detail = await (await call(base, cookie, `/api/devices/${device.id}`)).json();
    for (const key of ['username', 'port', 'notes', 'enabled', 'has_secret', 'host_key_fingerprint', 'identity_verified', 'last_ping_attempt_at', 'last_valid_at', 'freshness', 'events']) {
      assert.ok(key in detail, `kunci ${key} harus ada di detail`);
    }
    assert.equal(detail.has_secret, true);
    assertNoSecret(detail, 'lama');
  });
});

test('GET /api/devices/:id/clients: 400/404/409/502/200 + tanpa rahasia di respons/log', async () => {
  const store = createStubPool();
  const pinned = `sha256:${'B'.repeat(43)}=`;
  const device = store.addDevice({ name: 'AP-C', ip: '192.168.5.228', username: 'monitor', host_key_fingerprint: pinned });
  const tanpaRahasia = store.addDevice({ name: 'AP-N', ip: '192.168.5.226' });
  writeSecrets({ [device.id]: 'rahasiaClients' });

  const client = {
    hostname: 'laptop', ip: '192.168.5.50', mac: 'aa:bb:cc:dd:ee:ff', radio: 'na', ssid: 'wlan0',
    signal: -55, rssi: 40, uptime_s: 120, tx_bytes: 1, rx_bytes: 2, tx_rate: 3, rx_rate: 4, satisfaction: 98,
  };
  let received = null;
  const observedAt = '2026-10-16T01:02:03.000Z';

  await withServer(store, async (base) => {
    const unauth = await fetch(`${base}/api/devices/${device.id}/clients`);
    assert.equal(unauth.status, 401);

    const cookie = await login(base);
    const bad = await call(base, cookie, '/api/devices/abc/clients');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_id' });

    const missing = await call(base, cookie, '/api/devices/999/clients');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });

    const noSecret = await call(base, cookie, `/api/devices/${tanpaRahasia.id}/clients`);
    assert.equal(noSecret.status, 409);
    assert.deepEqual(await noSecret.json(), { error: 'no_secret' });

    const ok = await call(base, cookie, `/api/devices/${device.id}/clients`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body, { observed_at: observedAt, total: 1, truncated: false, clients: [client] });
    assertNoSecret(body, 'rahasiaClients');
    assert.deepEqual(received, {
      ip: '192.168.5.228', port: 22, username: 'monitor', password: 'rahasiaClients', hostKeyFingerprint: pinned,
    });
  }, {
    clients: async (args) => {
      received = args;
      return { ok: true, clients: [client], total: 1, truncated: false, observedAt };
    },
  });

  await withServer(store, async (base) => {
    const cookie = await login(base);
    const lines = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      lines.push(String(chunk));
      return original(chunk, ...rest);
    };
    let res;
    try {
      res = await call(base, cookie, `/api/devices/${device.id}/clients`);
    } finally {
      process.stdout.write = original;
    }
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'clients_failed', code: 'host_key_changed' });
    const joined = lines.join('');
    assert.match(joined, /clients_failed/);
    assert.doesNotMatch(joined, /rahasiaClients|192\.168\.5\.228/);
  }, { clients: async () => ({ ok: false, code: 'host_key_changed' }) });
});

test('listClients: host key wajib cocok, pemetaan mca-dump, batas 200, koneksi selalu ditutup', async () => {
  const hostKey = Buffer.from('host-key-bytes');
  const pinned = `sha256:${createHash('sha256').update(hostKey).digest('base64')}`;
  const auth = { ip: '192.168.5.228', port: 22, username: 'monitor', password: 'rahasiaClients' };

  // Stub ssh2: hostVerifier dipanggil seperti ssh2 asli; ditolak → error lalu tidak ready.
  function fakeClient({ stdout = '', fail, execError, hang } = {}) {
    const client = new EventEmitter();
    client.closed = 0;
    client.commands = [];
    client.end = () => { client.closed += 1; };
    client.destroy = () => { client.closed += 1; };
    client.connect = (config) => {
      client.config = config;
      if (hang) return;
      setImmediate(() => {
        if (!config.hostVerifier(hostKey)) {
          client.emit('error', Object.assign(new Error('host key ditolak'), { level: 'client-socket' }));
          return;
        }
        if (fail) {
          client.emit('error', Object.assign(new Error('gagal'), fail));
          return;
        }
        client.emit('ready');
      });
    };
    client.exec = (command, cb) => {
      client.commands.push(command);
      if (execError) {
        cb(new Error('exec gagal'));
        return;
      }
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      setImmediate(() => {
        stream.emit('data', Buffer.from(stdout));
        stream.emit('close');
      });
    };
    return client;
  }
  const run = (client, extra = {}, opts = {}) =>
    listClients({ ...auth, ...extra }, { Client: function StubClient() { return client; }, ...opts });

  const dump = JSON.stringify({
    vap_table: [
      {
        name: 'wlan0', radio: 'ng', num_sta: 1,
        sta_table: [{
          hostname: 'hp', ip: '192.168.5.50', mac: 'aa:bb:cc:dd:ee:ff', rssi: 40, signal: -56,
          uptime: 300, tx_bytes: 10, rx_bytes: 20, tx_rate: 72000, rx_rate: 65000, satisfaction: 97,
        }],
      },
      { name: 'wlan1', radio: 'na', num_sta: 1, sta_table: [{ mac: '11:22:33:44:55:66' }] },
    ],
  });
  const okClient = fakeClient({ stdout: dump });
  const ok = await run(okClient, { hostKeyFingerprint: pinned });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 2);
  assert.equal(ok.truncated, false);
  assert.match(ok.observedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(ok.clients[0], {
    hostname: 'hp', ip: '192.168.5.50', mac: 'aa:bb:cc:dd:ee:ff', radio: 'ng', ssid: 'wlan0',
    signal: -56, rssi: 40, uptime_s: 300, tx_bytes: 10, rx_bytes: 20, tx_rate: 72000, rx_rate: 65000, satisfaction: 97,
  });
  // Field yang tidak ada → null, bukan nol.
  assert.equal(ok.clients[1].hostname, null);
  assert.equal(ok.clients[1].signal, null);
  assert.equal(ok.clients[1].ssid, 'wlan1');
  assert.deepEqual(okClient.commands, ['mca-dump']);
  assert.equal(okClient.config.password, 'rahasiaClients');
  assert.equal(okClient.closed, 2, 'end + destroy dipanggil di finally');

  // Lebih dari 200 client → dipotong, total tetap jumlah seluruhnya.
  const many = JSON.stringify({
    vap_table: [{ name: 'wlan0', radio: 'ng', num_sta: 250, sta_table: Array.from({ length: 250 }, (_, i) => ({ mac: `m${i}` })) }],
  });
  const truncated = await run(fakeClient({ stdout: many }), { hostKeyFingerprint: pinned });
  assert.equal(truncated.clients.length, 200);
  assert.equal(truncated.total, 250);
  assert.equal(truncated.truncated, true);

  const cases = [
    [{}, { hostKeyFingerprint: null }, 'host_key_unpinned'],
    [{}, { hostKeyFingerprint: `sha256:${'C'.repeat(43)}=` }, 'host_key_changed'],
    [{ fail: { level: 'client-authentication' } }, { hostKeyFingerprint: pinned }, 'auth_failed'],
    [{ fail: { level: 'client-socket' } }, { hostKeyFingerprint: pinned }, 'connect_failed'],
    [{ stdout: 'bukan json' }, { hostKeyFingerprint: pinned }, 'parse_failed'],
    [{ stdout: '{"uptime":1}' }, { hostKeyFingerprint: pinned }, 'parse_failed'],
    [{ execError: true }, { hostKeyFingerprint: pinned }, 'connect_failed'],
  ];
  for (const [opts, extra, code] of cases) {
    const client = fakeClient(opts);
    const result = await run(client, extra);
    assert.deepEqual(result, { ok: false, code }, code);
    assert.equal(client.closed, 2, `end + destroy dipanggil (${code})`);
  }

  const hanging = fakeClient({ hang: true });
  const timeout = await run(hanging, { hostKeyFingerprint: pinned }, { timeoutMs: 20 });
  assert.deepEqual(timeout, { ok: false, code: 'timeout' });
  assert.equal(hanging.closed, 2);
});
