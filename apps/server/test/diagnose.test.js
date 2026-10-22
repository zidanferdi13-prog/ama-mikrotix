// Diagnosa rule-based + redaksi payload AI + endpoint /api/diagnose (stub SSH/AI, tanpa jaringan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AMA_JWT_SECRET = 'test-secret';
process.env.AMA_AUTH_USER = 'operator';
process.env.AMA_AUTH_PASSWORD = 'rahasia';
const SECRETS = join(mkdtempSync(join(tmpdir(), 'ama-diag-')), 'secrets.json');
writeFileSync(SECRETS, JSON.stringify({ 1: 'pw-ap' }));
process.env.AMA_SECRETS_FILE = SECRETS;

const { diagnose, matchClient } = await import('@ama/shared');
const { buildPayload, redact } = await import('../src/ai.js');
const { gatewayFrom } = await import('../src/ssh-diagnose.js');
const { createApp } = await import('../src/app.js');

const ping = (latency, loss = 0) => ({ values: { internet_latency_ms: latency, internet_loss_percent: loss }, internet: { status: latency == null ? 'invalid' : 'ok', code: latency == null ? 'no_reply' : null } });
const dnsFail = { values: { internet_latency_ms: null, internet_loss_percent: null }, internet: { status: 'invalid', code: 'dns_failed' } };
const client = (over = {}) => ({ hostname: 'LAPTOP-BUDI', ip: '192.168.5.77', mac: 'aa:bb:cc:dd:ee:ff', radio: 'na', signal: -55, noise: -105, satisfaction: 97, tx_rate: 144000, tx_retries: 10, tx_packets: 1000, asset_name: 'NB-012', asset_owner: 'Budi Santoso', ...over });
const live = (over = {}) => ({ ok: true, gatewayIp: '192.168.5.20', gateway: ping(0.3), publicIp: ping(17), internet: ping(18), sample: { uptime_seconds: 86400, memory_used_percent: 40, load_1: 0.3, eth_speed_mbps: 1000, eth_up: 1, radio_ng_cu_total: 20, radio_na_cu_total: 10 }, clients: [client()], total: 1, ...over });

test('diagnose: semua sehat → ok', () => {
  const r = diagnose({ live: live(), target: client(), targetQuery: 'budi' });
  assert.equal(r.verdict, 'ok');
});

test('diagnose: sinyal client -83 dBm → bad, temuan client di urutan pertama', () => {
  const r = diagnose({ live: live(), target: client({ signal: -83 }), targetQuery: 'budi' });
  assert.equal(r.verdict, 'bad');
  assert.equal(r.findings[0].area, 'client');
  assert.match(r.findings[0].title, /-83 dBm/);
});

test('diagnose: DNS gagal padahal 8.8.8.8 jalan → bad dengan pesan DNS', () => {
  const r = diagnose({ live: live({ internet: dnsFail }) });
  assert.equal(r.verdict, 'bad');
  assert.ok(r.findings.some((f) => /DNS gagal/.test(f.title) && /hanya DNS/.test(f.detail)));
});

test('diagnose: gateway tidak membalas → masalah uplink; client tanpa IP → masalah DHCP', () => {
  const r = diagnose({ live: live({ gateway: ping(null, 100), publicIp: ping(null, 100), internet: ping(null, 100) }), target: client({ ip: null }) });
  assert.ok(r.findings.some((f) => f.area === 'uplink' && f.level === 'bad'));
  assert.ok(r.findings.some((f) => /belum punya IP/.test(f.title)));
});

test('diagnose: SSH gagal → unknown', () => {
  assert.equal(diagnose({ live: { ok: false, code: 'timeout' } }).verdict, 'unknown');
});

test('matchClient: MAC format bebas, IP persis, nama/pemilik sebagian', () => {
  const list = [client(), client({ hostname: 'HP-SITI', ip: '192.168.5.80', mac: '11:22:33:44:55:66', asset_owner: 'Siti' })];
  assert.equal(matchClient(list, 'AA-BB-CC-DD-EE-FF').length, 1);
  assert.equal(matchClient(list, '192.168.5.80')[0].hostname, 'HP-SITI');
  assert.equal(matchClient(list, 'budi').length, 1);
  assert.equal(matchClient(list, '192.168.5').length, 0);
});

test('buildPayload: MAC/IP/nama/pemilik client tidak ikut ke AI; IP gateway tetap', () => {
  const target = client({ signal: -83 });
  const l = live();
  const result = diagnose({ live: l, target, targetQuery: 'budi' });
  const text = JSON.stringify(buildPayload({ device: { name: 'AP-1', model: 'UAP-AC-LR' }, result, live: l, target }));
  for (const secret of ['aa:bb:cc:dd:ee:ff', '192.168.5.77', 'LAPTOP-BUDI', 'Budi Santoso', 'NB-012']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('192.168.5.20'));
  assert.equal(redact('x 10.0.0.1 AA:BB:CC:DD:EE:FF'), 'x [ip] [mac]');
});

test('gatewayFrom: hanya IPv4 valid', () => {
  assert.equal(gatewayFrom('default via 192.168.5.20 dev br0\n'), '192.168.5.20');
  assert.equal(gatewayFrom('default via 1.2.3.4;reboot dev br0'), null);
  assert.equal(gatewayFrom(''), null);
});

function stubPool() {
  const device = { id: 1, name: 'AP-1', ip: '10.0.0.1', port: 22, username: 'admin', host_key_fingerprint: 'sha256:x', enabled: 1 };
  return {
    query: async (sql) => {
      if (/FROM devices WHERE enabled = 1/.test(sql)) return [device];
      if (/FROM devices WHERE id = \?/.test(sql)) return [device];
      return [];
    },
  };
}

async function withServer(options, run) {
  const app = createApp({ pool: stubPool(), allowedOrigin: 'http://localhost:5173', ...options });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: 'rahasia' }) });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const post = (body) => fetch(`${base}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    await run(post);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('POST /api/diagnose: cari user di semua AP → diagnosa + AI; password tidak bocor', async () => {
  let aiPayload = null;
  let sshCreds = null;
  await withServer({
    clients: async () => ({ ok: true, clients: [client({ signal: -83 })], total: 1 }),
    diagnoser: async (creds) => {
      sshCreds = creds;
      return { ...live(), clients: [client({ signal: -83 })], observedAt: '2026-10-22T03:00:00.000Z' };
    },
    ai: async (payload) => {
      aiPayload = payload;
      return { ok: true, text: 'Sinyal lemah.', model: 'stub' };
    },
    aiEnabled: () => true,
  }, async (post) => {
    const res = await post({ query: 'budi' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'done');
    assert.equal(body.verdict, 'bad');
    assert.equal(body.target.hostname, 'LAPTOP-BUDI');
    assert.equal(body.ai.text, 'Sinyal lemah.');
    assert.equal(sshCreds.password, 'pw-ap');
    assert.ok(!JSON.stringify(body).includes('pw-ap'));
    assert.ok(!JSON.stringify(aiPayload).includes('Budi Santoso'));

    const none = await (await post({ query: 'tidak-ada' })).json();
    assert.equal(none.status, 'not_found');
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ device_id: 'x' })).status, 400);
  });
});

test('POST /api/diagnose: device_id tanpa query, AI mati → rule-based saja', async () => {
  await withServer({ diagnoser: async () => live(), aiEnabled: () => false, ai: async () => assert.fail('AI tidak boleh dipanggil') }, async (post) => {
    const body = await (await post({ device_id: 1 })).json();
    assert.equal(body.verdict, 'ok');
    assert.deepEqual(body.ai, { ok: false, code: 'ai_disabled' });
  });
});
