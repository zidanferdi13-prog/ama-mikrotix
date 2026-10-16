// Uji API Alert Center §8–§10 (skenario 17: user tanpa izin).
// Pool = tabel alert in-memory: transisi status dan riwayat diperiksa sungguhan,
// bukan hanya bentuk SQL-nya.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.AMA_JWT_SECRET = 'test-secret';
process.env.AMA_AUTH_USER = 'operator';
process.env.AMA_AUTH_PASSWORD = 'rahasia';

const { createApp } = await import('../src/app.js');

const T0 = Date.parse('2026-10-16T02:00:00.000Z');
const at = (minAgo) => new Date(T0 - minAgo * 60_000);

function alertPool(seed = []) {
  const state = {
    alerts: seed.map((row, index) => ({
      id: index + 1,
      rule_id: 'ap.latency.high',
      severity: 'warning',
      status: 'active',
      device_id: 1,
      device_name: 'AP-1',
      target: null,
      title: 'Latency tinggi',
      first_seen_at: at(30),
      last_seen_at: at(1),
      updated_at: at(1),
      resolved_at: null,
      acknowledged_at: null,
      acknowledged_by: null,
      reopen_count: 0,
      evidence: { metric: 'latency_ms' },
      diagnosis: null,
      ...row,
    })),
    events: [],
  };
  const find = (id) => state.alerts.find((row) => row.id === Number(id)) ?? null;

  function route(sql, params = []) {
    if (/SELECT id, status FROM alerts WHERE id = \? FOR UPDATE/.test(sql)) {
      const row = find(params[0]);
      return Promise.resolve(row ? [{ id: row.id, status: row.status }] : []);
    }
    if (/UPDATE alerts SET status = \?, acknowledged_at/.test(sql)) {
      const row = find(params[4]);
      if (row) {
        row.status = params[0];
        row.acknowledged_at = params[1];
        row.acknowledged_by = params[2];
        row.updated_at = params[3];
      }
      return Promise.resolve({ affectedRows: row ? 1 : 0 });
    }
    if (/UPDATE alerts SET status = \?, resolved_at/.test(sql)) {
      const row = find(params[3]);
      if (row) {
        row.status = params[0];
        row.resolved_at = params[1];
        row.updated_at = params[2];
      }
      return Promise.resolve({ affectedRows: row ? 1 : 0 });
    }
    if (/INSERT INTO alert_events/.test(sql)) {
      state.events.push({ alert_id: Number(params[0]), at: params[1], from_status: params[2], to_status: params[3], actor: params[4] });
      return Promise.resolve({ insertId: state.events.length });
    }
    if (/FROM alerts a LEFT JOIN devices d ON d.id = a.device_id WHERE a.id = \?/.test(sql)) {
      const row = find(params[0]);
      return Promise.resolve(row ? [row] : []);
    }
    if (/FROM alert_events WHERE alert_id/.test(sql)) {
      return Promise.resolve(state.events.filter((e) => e.alert_id === Number(params[0])).map((e) => ({ ...e, note: { via: 'api' } })));
    }
    if (/FROM device_metrics/.test(sql) || /FROM client_observations/.test(sql)) return Promise.resolve([]);
    if (/FROM alerts a LEFT JOIN/.test(sql)) {
      let rows = state.alerts;
      if (/a.severity = \?/.test(sql)) rows = rows.filter((r) => r.severity === params[0]);
      if (/a.status = \?/.test(sql)) rows = rows.filter((r) => r.status === params[0]);
      if (/a.device_id = \?/.test(sql)) rows = rows.filter((r) => r.device_id === Number(params[0]));
      return Promise.resolve(rows);
    }
    if (/SELECT severity, status, COUNT/.test(sql)) {
      return Promise.resolve(state.alerts.map((row) => ({ severity: row.severity, status: row.status, n: 1 })));
    }
    if (/COUNT\(\*\) AS n FROM alerts WHERE resolved_at/.test(sql)) {
      return Promise.resolve([{ n: state.alerts.filter((r) => r.resolved_at).length }]);
    }
    if (/COUNT\(DISTINCT device_id\)/.test(sql)) return Promise.resolve([{ n: 1 }]);
    if (/rule_id LIKE 'incident/.test(sql)) return Promise.resolve([{ n: 0 }]);
    // Jam server yang menilai kesegaran, jadi stub memakai waktu nyata.
    if (/collector_heartbeat/.test(sql)) return Promise.resolve([{ last_heartbeat_at: new Date() }]);
    return Promise.resolve([]);
  }

  const conn = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: (sql, params) => route(sql, params),
  };
  return { pool: { query: (sql, params) => route(sql, params), getConnection: async () => conn }, state };
}

async function withServer(pool, run) {
  const app = createApp({ pool, allowedOrigin: 'http://localhost:5173' });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'rahasia' }),
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

// --- 17. User tanpa izin mencoba acknowledge ------------------------------------
test('skenario 17: acknowledge tanpa sesi → 401 dan status alert tidak berubah', async () => {
  const { pool, state } = alertPool([{}]);
  await withServer(pool, async (base) => {
    const res = await fetch(`${base}/api/alerts/1/ack`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(state.alerts[0].status, 'active');
    assert.equal(state.alerts[0].acknowledged_by, null);
    assert.equal(state.events.length, 0);
  });
});

test('acknowledge mencatat pengguna, waktu, dan riwayat', async () => {
  const { pool, state } = alertPool([{}]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/alerts/1/ack`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'acknowledged');
    assert.equal(body.acknowledged_by, 'operator');
    assert.ok(Date.parse(body.acknowledged_at) > 0);

    assert.equal(state.alerts[0].status, 'acknowledged');
    assert.equal(state.alerts[0].acknowledged_by, 'operator');
    assert.equal(state.events.length, 1);
    assert.deepEqual(
      { from: state.events[0].from_status, to: state.events[0].to_status, actor: state.events[0].actor },
      { from: 'active', to: 'acknowledged', actor: 'operator' },
    );

    // Acknowledge ulang tidak menambah riwayat dan tidak mengubah status.
    const again = await fetch(`${base}/api/alerts/1/ack`, { method: 'POST', headers: { cookie } });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).unchanged, true);
    assert.equal(state.events.length, 1);
  });
});

test('acknowledge alert yang sudah resolved → 409', async () => {
  const { pool, state } = alertPool([{ status: 'resolved', resolved_at: at(5) }]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/alerts/1/ack`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'already_resolved');
    assert.equal(state.events.length, 0);
  });
});

test('acknowledge id yang tidak ada → 404; id salah format → 400', async () => {
  const { pool } = alertPool([{}]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/alerts/99/ack`, { method: 'POST', headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/alerts/abc/ack`, { method: 'POST', headers: { cookie } })).status, 400);
  });
});

test('resolve manual mencatat waktu dan mengubah status', async () => {
  const { pool, state } = alertPool([{ status: 'acknowledged', acknowledged_at: at(10), acknowledged_by: 'operator' }]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/alerts/1/resolve`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'resolved');
    assert.ok(Date.parse(body.resolved_at) > 0);
    assert.equal(state.alerts[0].status, 'resolved');
    assert.equal(state.events[0].to_status, 'resolved');

    const again = await fetch(`${base}/api/alerts/1/resolve`, { method: 'POST', headers: { cookie } });
    assert.equal(again.status, 409);
  });
});

// --- Daftar, ringkasan, detail ---------------------------------------------------
test('daftar alert center: filter tervalidasi dan hasil terurut dari DB', async () => {
  const { pool } = alertPool([{ severity: 'critical' }, { severity: 'info', rule_id: 'ap.reboot' }, { severity: 'warning', device_id: 2 }]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    const all = await (await fetch(`${base}/api/alert-center`, { headers: { cookie } })).json();
    assert.equal(all.alerts.length, 3);
    assert.equal(all.limit, 100);

    const critical = await (await fetch(`${base}/api/alert-center?severity=critical`, { headers: { cookie } })).json();
    assert.deepEqual(critical.alerts.map((a) => a.severity), ['critical']);

    const device = await (await fetch(`${base}/api/alert-center?device_id=2`, { headers: { cookie } })).json();
    assert.deepEqual(device.alerts.map((a) => a.device_id), [2]);

    for (const bad of ['severity=urgent', 'status=selesai', 'device_id=abc', 'limit=0', 'limit=999', 'offset=-1', 'from=bukan']) {
      const res = await fetch(`${base}/api/alert-center?${bad}`, { headers: { cookie } });
      assert.equal(res.status, 400, bad);
    }

    // Tanpa sesi → 401.
    assert.equal((await fetch(`${base}/api/alert-center`)).status, 401);
  });
});

test('detail insiden: 400/404 dan bentuk respons lengkap', async () => {
  const { pool } = alertPool([{ severity: 'critical', target: 'aa:bb:cc:00:00:01' }]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/alerts/abc`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/alerts/42`, { headers: { cookie } })).status, 404);

    const res = await fetch(`${base}/api/alerts/1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alert.id, 1);
    assert.equal(body.alert.device_name, 'AP-1');
    assert.ok(body.alert.duration_ms > 0);
    assert.deepEqual(body.alert.evidence, { metric: 'latency_ms' });
    assert.deepEqual(body.context.metrics, []);
    assert.ok(Date.parse(body.context.phases.before_from) < Date.parse(body.context.phases.during_from));
    assert.ok(Array.isArray(body.events));
  });
});

test('ringkasan alert: angka dari DB dan status kesegaran collector', async () => {
  const { pool } = alertPool([{}, { severity: 'critical', status: 'acknowledged' }, { status: 'resolved', resolved_at: at(5) }]);
  await withServer(pool, async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/alerts/summary`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.open, 2);
    assert.equal(body.by_severity.warning, 1);
    assert.equal(body.by_severity.critical, 1);
    assert.equal(body.by_status.acknowledged, 1);
    assert.equal(body.devices_affected, 1);
    assert.equal(body.resolved_in_period, 1);
    assert.equal(body.collector.fresh, true);
    assert.ok(Date.parse(body.period.from) < Date.parse(body.period.to));
  });
});
