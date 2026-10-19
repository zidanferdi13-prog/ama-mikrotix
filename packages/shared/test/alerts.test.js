// Uji rule engine + lifecycle §5–§10 dengan data mock (tanpa DB, tanpa jaringan).
// Skenario mengikuti daftar §10 spec. Skenario 16 (dua evaluasi bersamaan) diuji di
// scripts/smoke-alerts.mjs karena butuh DB nyata untuk GET_LOCK + UNIQUE open_key.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT,
  ALERT_RULES,
  alertDedupKey,
  correlateAlerts,
  detectReboots,
  evaluateClientRules,
  evaluateDeviceRules,
  planAlertChanges,
} from '../src/index.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-16T02:00:00.000Z');
const sec = (agoSec) => new Date(T0 - agoSec * 1000).toISOString();

const DEVICE = { id: 1, name: 'AP-1' };
const KEY = (rule_id, device_id = DEVICE.id, target = null) => alertDedupKey({ rule_id, device_id, target });

const pingRow = (agoSec, reachable, latency_ms = 2) => ({
  observed_at: sec(agoSec),
  reachable,
  latency_ms,
  collection_status: 'ok',
});

const systemRow = (agoSec, values = {}) => ({
  observed_at: sec(agoSec),
  collection_status: 'ok',
  uptime_seconds: values.uptime_seconds ?? 86_400,
  load_1: values.load_1 ?? 0.2,
  memory_used_percent: values.memory_used_percent ?? 40,
  client_count: values.client_count ?? 5,
  // Kolom link/radio (migrasi 006) diteruskan apa adanya; tidak diberi default.
  ...Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith('eth_') || k.startsWith('radio_'))),
});

const sshSample = (agoSec, ssh) => ({ observed_at: sec(agoSec), ssh });

const point = (agoSec, clients) => ({ observed_at: sec(agoSec), clients });

const client = (mac, signal_dbm = -55, bytes = 1000) => ({
  mac,
  signal_dbm,
  rssi: signal_dbm + 40,
  rx_bytes: bytes,
  tx_bytes: bytes,
});

function deviceEval({ atMs = T0, pingHistory = [], systemHistory = [], systemSamples = [], events = [], alerts = [], device = DEVICE } = {}) {
  return evaluateDeviceRules({
    atMs,
    device,
    metrics: {
      ping: {
        observed_at: pingHistory.at(-1)?.observed_at ?? null,
        reachable: pingHistory.at(-1)?.reachable ?? null,
        history: pingHistory,
      },
      system: {
        observed_at: systemHistory.at(-1)?.observed_at ?? null,
        collection_status: systemHistory.at(-1)?.collection_status ?? null,
        history: systemHistory,
      },
      systemSamples,
    },
    events,
    alerts: new Map(alerts.map((a) => [a.dedup_key ?? KEY(a.rule_id, a.device_id, a.target), a])),
  });
}

const findingOf = (findings, rule_id, target = null) =>
  findings.find((f) => f.rule_id === rule_id && (f.target ?? null) === target) ?? null;
const isActive = (findings, rule_id, target = null) => findingOf(findings, rule_id, target)?.active === true;
const activeRules = (findings) => findings.filter((f) => f.active).map((f) => f.rule_id).sort();

// --- 1. AP gagal ping tiga kali -------------------------------------------------
test('skenario 1: tiga kegagalan ping beruntun → ap.unreachable, tanpa menyimpulkan dari SSH', () => {
  const pingHistory = [pingRow(150, 1), pingRow(120, 1), pingRow(90, 0, null), pingRow(60, 0, null), pingRow(15, 0, null)];
  const { findings } = deviceEval({ pingHistory });

  assert.equal(isActive(findings, 'ap.unreachable'), true);
  const finding = findingOf(findings, 'ap.unreachable');
  assert.equal(finding.evidence.consecutive_failures, 3);
  assert.match(finding.evidence.note, /bukan dari kegagalan SSH/iu);
  assert.equal(isActive(findings, 'ap.ssh.unavailable'), false);

  // Dua kegagalan saja belum cukup (hysteresis 3 sampel).
  const partial = deviceEval({ pingHistory: [pingRow(120, 1), pingRow(90, 0, null), pingRow(15, 0, null)] }).findings;
  assert.equal(isActive(partial, 'ap.unreachable'), false);
});

// --- 2. SSH tidak merespons, ping berhasil --------------------------------------
test('skenario 2: ping normal + SSH timeout beruntun → ap.ssh.unavailable, bukan ap.unreachable', () => {
  const pingHistory = [pingRow(60, 1), pingRow(30, 1), pingRow(15, 1)];
  const systemSamples = [sshSample(120, { status: 'error', code: 'timeout' }), sshSample(60, { status: 'error', code: 'timeout' })];
  const systemHistory = [systemRow(120), systemRow(60)];
  const { findings, ssh } = deviceEval({ pingHistory, systemHistory, systemSamples });

  assert.equal(ssh.code, 'timeout');
  assert.equal(ssh.failCount, 2);
  assert.equal(isActive(findings, 'ap.ssh.unavailable'), true);
  assert.equal(isActive(findings, 'ap.unreachable'), false);
  assert.equal(isActive(findings, 'ap.metrics.stale'), false);
  assert.match(findingOf(findings, 'ap.ssh.unavailable').evidence.note, /tetap dianggap online/iu);

  // Satu kegagalan SSH belum cukup.
  const once = deviceEval({ pingHistory, systemHistory, systemSamples: [sshSample(60, { status: 'error', code: 'timeout' })] }).findings;
  assert.equal(isActive(once, 'ap.ssh.unavailable'), false);
});

// --- 3. SSH authentication gagal ------------------------------------------------
test('skenario 3: SSH auth gagal → ap.ssh.auth_failed, tidak pernah ap.unreachable', () => {
  const pingHistory = [pingRow(60, 1), pingRow(15, 1)];
  const systemSamples = [sshSample(120, { status: 'error', code: 'auth_failed' }), sshSample(60, { status: 'error', code: 'auth_failed' })];
  const { findings } = deviceEval({ pingHistory, systemHistory: [systemRow(120), systemRow(60)], systemSamples });

  assert.equal(isActive(findings, 'ap.ssh.auth_failed'), true);
  assert.equal(isActive(findings, 'ap.unreachable'), false);
  assert.equal(activeRules(findings).includes('ap.unreachable'), false);
  assert.equal(ALERT_RULES['ap.ssh.auth_failed'].severity, 'warning');
});

// --- 4. Collector berhenti mengirim data ----------------------------------------
test('skenario 4: ping terakhir terlalu tua → ap.collector_stalled, dan korelasi collector', () => {
  const { findings } = deviceEval({ pingHistory: [pingRow(300, 1), pingRow(240, 1)] });
  assert.equal(isActive(findings, 'ap.collector_stalled'), true);
  assert.equal(isActive(findings, 'ap.unreachable'), false);

  const correlations = correlateAlerts({
    atMs: T0,
    alerts: [],
    devices: [
      { id: 1, stale: true, client_count: null },
      { id: 2, stale: true, client_count: null },
    ],
    collectorAgeMs: 200_000,
  });
  const incident = correlations.find((c) => c.rule_id === 'incident.collector');
  assert.ok(incident, 'incident.collector harus muncul');
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.diagnosis.confidence, 'high');
  assert.equal(incident.diagnosis.scenario, 'D');
  assert.ok(incident.diagnosis.evidence_present.length > 0);
  assert.ok(incident.diagnosis.evidence_missing.length > 0);
  assert.deepEqual(incident.diagnosis.affected_devices, [1, 2]);
  assert.match(incident.diagnosis.note, /bukan AP/iu);
  // Insiden harus aktif: tanpa flag ini planAlertChanges() tidak pernah membuat barisnya.
  assert.equal(incident.active, true);
  const ops = planAlertChanges(correlations, [], { at: new Date(T0).toISOString() });
  assert.deepEqual(ops.map((op) => `${op.op}:${op.desired.rule_id}`), ['create:incident.collector']);
});

// --- 5. Latency tinggi selama durasi tertentu -----------------------------------
test('skenario 5: latency di atas ambang ≥3 menit → ap.latency.high; pulih ≥2 menit → resolve', () => {
  const breaching = [pingRow(180, 1, 150), pingRow(120, 1, 150), pingRow(60, 1, 150), pingRow(0, 1, 150)];
  const first = deviceEval({ pingHistory: breaching }).findings;
  assert.equal(isActive(first, 'ap.latency.high'), true);
  assert.equal(findingOf(first, 'ap.latency.high').evidence.breach_run_ms, 180_000);

  // 90 detik saja belum cukup untuk membuka.
  const shortBreach = deviceEval({ pingHistory: [pingRow(300, 1, 5), pingRow(90, 1, 150), pingRow(0, 1, 150)] }).findings;
  assert.equal(isActive(shortBreach, 'ap.latency.high'), false);

  // Latency normal ≥2 menit → kondisi pulih.
  const recovered = deviceEval({
    pingHistory: [pingRow(180, 1, 150), pingRow(120, 1, 40), pingRow(60, 1, 40), pingRow(0, 1, 40)],
    alerts: [{ id: 7, rule_id: 'ap.latency.high', device_id: DEVICE.id, dedup_key: KEY('ap.latency.high'), first_seen_at: sec(600), last_seen_at: sec(60) }],
  }).findings;
  assert.equal(isActive(recovered, 'ap.latency.high'), false);

  // Latency sangat tinggi (250+ selama 2 menit) → critical.
  const critical = deviceEval({ pingHistory: [pingRow(120, 1, 300), pingRow(0, 1, 300)] }).findings;
  assert.equal(isActive(critical, 'ap.latency.critical'), true);
  assert.equal(ALERT_RULES['ap.latency.critical'].severity, 'critical');
});

// --- 6. RAM tinggi selama beberapa interval -------------------------------------
test('skenario 6: RAM di atas ambang ≥5 menit → ap.memory.high', () => {
  const history = [systemRow(300, { memory_used_percent: 90 }), systemRow(240, { memory_used_percent: 92 }), systemRow(180, { memory_used_percent: 91 }), systemRow(120, { memory_used_percent: 93 }), systemRow(60, { memory_used_percent: 90 }), systemRow(0, { memory_used_percent: 88 })];
  const findings = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: history }).findings;
  assert.equal(isActive(findings, 'ap.memory.high'), true);

  const spikeOnly = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: [systemRow(120, { memory_used_percent: 40 }), systemRow(60, { memory_used_percent: 90 }), systemRow(0, { memory_used_percent: 90 })] }).findings;
  assert.equal(isActive(spikeOnly, 'ap.memory.high'), false);
});

// --- 7. Uptime turun akibat reboot ----------------------------------------------
test('skenario 7: uptime turun → ap.reboot (peristiwa, ditutup setelah TTL)', () => {
  assert.equal(detectReboots([systemRow(600, { uptime_seconds: 5000 }), systemRow(60, { uptime_seconds: 30 })])[0].uptime_before_s, 5000);

  const history = [systemRow(600, { uptime_seconds: 5000 }), systemRow(60, { uptime_seconds: 30 })];
  const findings = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: history }).findings;
  assert.equal(isActive(findings, 'ap.reboot'), true);
  assert.match(findingOf(findings, 'ap.reboot').evidence.note, /Bukan bukti kehilangan daya/iu);

  // Reboot 16 menit lalu: masih di dalam jendela pengamatan, tapi sudah lewat TTL 15 menit.
  const expired = evaluateDeviceRules({
    atMs: T0,
    device: DEVICE,
    metrics: {
      ping: { observed_at: sec(0), reachable: 1, history: [pingRow(0, 1)] },
      system: { observed_at: sec(1000), collection_status: 'ok', history: [systemRow(1100, { uptime_seconds: 5000 }), systemRow(1000, { uptime_seconds: 30 })] },
    },
    alerts: new Map([[KEY('ap.reboot'), { id: 3, rule_id: 'ap.reboot', device_id: DEVICE.id, dedup_key: KEY('ap.reboot'), first_seen_at: sec(1000), last_seen_at: sec(1000) }]]),
  }).findings;
  assert.equal(isActive(expired, 'ap.reboot'), false);
});

// --- 8. Satu client RSSI rendah, client lain normal -----------------------------
test('skenario 8: satu client sinyal lemah → skenario B, client lain tidak terpengaruh', () => {
  const macWeak = 'aa:bb:cc:00:00:01';
  const macGood = 'aa:bb:cc:00:00:02';
  const points = [180, 120, 60, 0].map((ago) => point(ago, [client(macWeak, -75), client(macGood, -50)]));
  const findings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points, alerts: new Map(), apEvaluable: true, healthyClients: 1 });
  assert.equal(isActive(findings, 'client.signal.weak', macWeak), true);
  assert.equal(isActive(findings, 'client.signal.weak', macGood), false);
  assert.equal(isActive(findings, 'client.signal.critical', macWeak), false);
  assert.equal(findingOf(findings, 'client.signal.weak', macWeak).diagnosis.scenario, 'B');

  const correlations = correlateAlerts({
    atMs: T0,
    alerts: [{ rule_id: 'client.signal.weak', device_id: DEVICE.id, target: macWeak }],
    devices: [{ id: DEVICE.id, stale: false, client_count: 2 }],
    collectorAgeMs: 1000,
  });
  const scenarioB = correlations.find((c) => c.rule_id === 'correlation.client_issue');
  assert.ok(scenarioB, 'skenario B harus muncul');
  assert.equal(scenarioB.diagnosis.confidence, 'low');
  assert.deepEqual(scenarioB.diagnosis.affected_clients, [macWeak]);
  assert.ok(scenarioB.diagnosis.evidence_present.length > 0);
  assert.ok(scenarioB.diagnosis.evidence_missing.length > 0);
  assert.match(scenarioB.diagnosis.note, /AP dan client lain normal/iu);
});

test('skenario 8b: baris korelasi B yang terbuka tidak mematikan deteksinya sendiri', () => {
  const mac = 'aa:bb:cc:00:00:04';
  const clientAlert = { rule_id: 'client.signal.weak', device_id: DEVICE.id, target: mac, severity: 'warning' };
  const devices = [{ id: DEVICE.id, stale: false, client_count: 2 }];
  const first = correlateAlerts({ atMs: T0, alerts: [clientAlert], devices, collectorAgeMs: 1000 });
  const row = first.find((c) => c.rule_id === 'correlation.client_issue');
  assert.ok(row, 'siklus pertama harus mendeteksi skenario B');

  // Siklus berikutnya: baris korelasi (dan insiden) ikut termuat sebagai alert terbuka.
  const next = correlateAlerts({
    atMs: T0 + 15_000,
    alerts: [clientAlert, { rule_id: row.rule_id, device_id: DEVICE.id, target: null, severity: 'info' }, { rule_id: 'incident.ap', device_id: DEVICE.id, target: null, severity: 'warning' }],
    devices,
    collectorAgeMs: 1000,
  });
  assert.ok(
    next.some((c) => c.rule_id === 'correlation.client_issue'),
    'korelasi B harus tetap terdeteksi selama client masih bermasalah',
  );
});

test('skenario 8c: alert sinyal client yang sudah pergi ditutup; yang masih lemah tetap', () => {
  const mac = 'aa:bb:cc:00:00:05';
  const open = (ruleId) => [KEY(ruleId, DEVICE.id, mac), { id: 8, rule_id: ruleId, device_id: DEVICE.id, target: mac, dedup_key: KEY(ruleId, DEVICE.id, mac), first_seen_at: sec(600), last_seen_at: sec(0) }];
  const alerts = new Map([open('client.signal.weak'), open('client.signal.critical')]);

  const gone = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: [point(120, []), point(60, []), point(0, [])], alerts, apEvaluable: true });
  for (const ruleId of ['client.signal.weak', 'client.signal.critical']) {
    assert.equal(findingOf(gone, ruleId, mac)?.active, false, `${ruleId} harus ditutup`);
  }

  // Masih terlihat dengan sinyal sangat lemah → tetap aktif.
  const weak = [600, 480, 360, 240, 120, 0].map((ago) => point(ago, [client(mac, -88)]));
  const still = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: weak, alerts, apEvaluable: true });
  assert.equal(isActive(still, 'client.signal.critical', mac), true);
});

// --- 9. Client hilang pada satu snapshot lalu kembali ---------------------------
test('skenario 9: hilang satu snapshot bukan disconnect; dua snapshot baru disconnect', () => {
  const mac = 'aa:bb:cc:00:00:03';
  const withGap = [240, 180, 120, 60, 0].map((ago, index) => point(ago, index === 2 ? [] : [client(mac)]));
  const gapFindings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: withGap, alerts: new Map(), apEvaluable: true, healthyClients: 0 });
  assert.equal(isActive(gapFindings, 'client.disconnected', mac), false);
  assert.equal(isActive(gapFindings, 'client.flapping', mac), false);

  const gone = [240, 180, 120, 60, 0].map((ago, index) => point(ago, index < 2 ? [client(mac)] : []));
  const goneFindings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: gone, alerts: new Map(), apEvaluable: true, healthyClients: 0 });
  assert.equal(isActive(goneFindings, 'client.disconnected', mac), true);
  assert.equal(findingOf(goneFindings, 'client.disconnected', mac).evidence.missing_snapshots, 3);

  // Muncul lagi → resolved.
  const backFindings = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: [...gone, point(-15, [client(mac)])],
    alerts: new Map([[KEY('client.disconnected', DEVICE.id, mac), { id: 4, rule_id: 'client.disconnected', device_id: DEVICE.id, target: mac, dedup_key: KEY('client.disconnected', DEVICE.id, mac), first_seen_at: sec(120), last_seen_at: sec(0) }]]),
    apEvaluable: true,
  });
  assert.equal(isActive(backFindings, 'client.disconnected', mac), false);

  // Hilang dari AP ini tapi terlihat di AP lain (roaming) → bukan disconnect.
  const roamingFindings = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: gone,
    alerts: new Map(),
    apEvaluable: true,
    seenElsewhere: new Map([[mac, { atMs: T0 - 30_000, deviceId: 2 }]]),
  });
  assert.equal(isActive(roamingFindings, 'client.disconnected', mac), false);

  // Terlihat di AP lain lebih lama dari jendela roaming → tetap disconnect.
  const staleFindings = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: gone,
    alerts: new Map(),
    apEvaluable: true,
    seenElsewhere: new Map([[mac, { atMs: T0 - ALERT.clientElsewhereMs - 60_000, deviceId: 2 }]]),
  });
  assert.equal(isActive(staleFindings, 'client.disconnected', mac), true);

  // Baris terbuka ikut pulih saat client terlihat di AP lain.
  const openKey = KEY('client.disconnected', DEVICE.id, mac);
  const roamBackFindings = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: gone,
    alerts: new Map([[openKey, { id: 5, rule_id: 'client.disconnected', device_id: DEVICE.id, target: mac, dedup_key: openKey, first_seen_at: sec(120), last_seen_at: sec(0) }]]),
    apEvaluable: true,
    seenElsewhere: new Map([[mac, { atMs: T0 - 30_000, deviceId: 2 }]]),
  });
  assert.equal(isActive(roamBackFindings, 'client.disconnected', mac), false);

  // Tak terlihat sama sekali sepanjang jendela (sudah pergi) → baris terbuka ditutup,
  // bukan menggantung selamanya.
  const neverWindow = [point(120, []), point(60, []), point(0, [])];
  const goneForever = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: neverWindow,
    alerts: new Map([[openKey, { id: 6, rule_id: 'client.disconnected', device_id: DEVICE.id, target: mac, dedup_key: openKey, first_seen_at: sec(120), last_seen_at: sec(0) }]]),
    apEvaluable: true,
  });
  assert.equal(goneForever.some((f) => f.rule_id === 'client.disconnected' && f.target === mac && f.active), false);
  assert.match(findingOf(goneForever, 'client.disconnected', mac).evidence.note, /jendela evaluasi/);

  // Masih terlihat di dalam jendela (baru hilang) → alert tetap terbuka.
  const seenThenGone = [point(300, [client(mac)]), point(120, [client(mac)]), point(60, []), point(0, [])];
  const stillOpen = evaluateClientRules({
    atMs: T0,
    deviceId: DEVICE.id,
    points: seenThenGone,
    alerts: new Map([[openKey, { id: 7, rule_id: 'client.disconnected', device_id: DEVICE.id, target: mac, dedup_key: openKey, first_seen_at: sec(120), last_seen_at: sec(0) }]]),
    apEvaluable: true,
  });
  assert.equal(isActive(stillOpen, 'client.disconnected', mac), true);
});

// --- 10. Client flapping berulang ----------------------------------------------
test('skenario 10: tiga episode hilang→muncul → client.flapping', () => {
  const mac = 'aa:bb:cc:00:00:04';
  const pattern = [1, 0, 1, 0, 1, 0, 1];
  const points = pattern.map((present, index) => point(420 - index * 60, present ? [client(mac)] : []));
  const findings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points, alerts: new Map(), apEvaluable: true });
  assert.equal(isActive(findings, 'client.flapping', mac), true);
  assert.equal(findingOf(findings, 'client.flapping', mac).evidence.episodes, 3);

  const twoEpisodes = [1, 0, 1, 0, 1].map((present, index) => point(240 - index * 60, present ? [client(mac)] : []));
  const fewer = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: twoEpisodes, alerts: new Map(), apEvaluable: true });
  assert.equal(isActive(fewer, 'client.flapping', mac), false);
});

// --- 11. Banyak client memburuk bersamaan ---------------------------------------
test('skenario 11: beberapa client lemah + resource AP → skenario A dengan client terdampak', () => {
  const macs = ['aa:bb:cc:00:00:0a', 'aa:bb:cc:00:00:0b', 'aa:bb:cc:00:00:0c'];
  // Counter bergerak agar client.traffic_stalled tidak ikut aktif.
  const points = [180, 120, 60, 0].map((ago, index) => point(ago, [...macs.map((m) => client(m, -78, 1000 + index * 500)), client('aa:bb:cc:00:00:0d', -45, 2000)]));
  const findings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points, alerts: new Map(), apEvaluable: true });
  const clientAlerts = findings.filter((f) => f.active && f.rule_id.startsWith('client.signal.')).map((f) => ({ rule_id: f.rule_id, device_id: DEVICE.id, target: f.target }));
  assert.equal(clientAlerts.length, macs.length);
  assert.deepEqual([...new Set(activeRules(findings))], ['client.signal.weak']);

  const correlations = correlateAlerts({
    atMs: T0,
    alerts: [...clientAlerts, { rule_id: 'ap.memory.high', device_id: DEVICE.id, target: null }],
    devices: [{ id: DEVICE.id, stale: false, client_count: 4 }],
    collectorAgeMs: 1000,
  });
  const scenarioA = correlations.find((c) => c.rule_id === 'incident.ap');
  assert.ok(scenarioA, 'skenario A harus muncul');
  assert.equal(scenarioA.diagnosis.confidence, 'medium');
  assert.deepEqual([...scenarioA.diagnosis.affected_clients].sort(), macs);
  assert.equal(scenarioA.diagnosis.indicators.length, 2);
});


// --- 12. Beberapa AP terganggu bersamaan ----------------------------------------
test('skenario 12: tiga AP latency tinggi tanpa putus → incident.shared_network', () => {
  const alerts = [
    { rule_id: 'ap.latency.high', device_id: 1, target: null },
    { rule_id: 'ap.latency.high', device_id: 2, target: null },
    { rule_id: 'ap.latency.critical', device_id: 3, target: null },
  ];
  const devices = [1, 2, 3].map((id) => ({ id, stale: false, client_count: 3 }));
  const correlations = correlateAlerts({ atMs: T0, alerts, devices, collectorAgeMs: 1000 });
  const shared = correlations.find((c) => c.rule_id === 'incident.shared_network');
  assert.ok(shared, 'incident.shared_network harus muncul');
  assert.equal(shared.diagnosis.scenario, 'C');
  assert.equal(shared.diagnosis.confidence, 'high');
  assert.deepEqual(shared.diagnosis.affected_devices, [1, 2, 3]);
  assert.match(shared.diagnosis.note, /tidak dapat dipastikan/iu);

  // Hanya satu AP → bukan pola bersama.
  const single = correlateAlerts({ atMs: T0, alerts: [alerts[0]], devices, collectorAgeMs: 1000 });
  assert.equal(single.some((c) => c.rule_id === 'incident.shared_network'), false);
});

// --- 13. Collector gagal → status AP tidak dapat diverifikasi --------------------
test('skenario 13: pemeriksaan ping tanpa hasil → ap.unverified, bukan ap.unreachable', () => {
  const pingHistory = [{ ...pingRow(15, null), reachable: null, latency_ms: null, code: 'timeout' }];
  const findings = deviceEval({ pingHistory }).findings;
  assert.equal(isActive(findings, 'ap.unverified'), true);
  assert.equal(isActive(findings, 'ap.unreachable'), false);
  assert.match(findingOf(findings, 'ap.unverified').evidence.note, /offline tidak dapat disimpulkan/iu);

  // Ping mati + SSH gagal: kegagalan SSH tidak menambah informasi.
  const ssh = deviceEval({ pingHistory: [pingRow(90, 0, null), pingRow(60, 0, null), pingRow(15, 0, null)], systemSamples: [sshSample(60, { status: 'error', code: 'timeout' })] });
  assert.equal(ssh.ssh.suppressed, true);
  const sshRules = ssh.findings.filter((f) => f.rule_id.startsWith('ap.ssh.') && f.active);
  assert.deepEqual(sshRules, []);
});

// --- 14. Alert pulih lalu muncul kembali ----------------------------------------
test('skenario 14: pulih lalu muncul lagi dalam cooldown → reopen baris lama', () => {
  const item = { rule_id: 'ap.latency.high', device_id: DEVICE.id, target: null, active: true, since: sec(0), evidence: {}, dedup_key: KEY('ap.latency.high') };
  const resolved = { id: 9, rule_id: 'ap.latency.high', device_id: DEVICE.id, status: 'resolved', dedup_key: KEY('ap.latency.high'), resolved_at: new Date(T0 - 10 * MIN).toISOString(), last_seen_at: new Date(T0 - 20 * MIN).toISOString() };

  const ops = planAlertChanges([item], [resolved], { at: new Date(T0).toISOString() });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'reopen');
  assert.equal(ops[0].id, 9);

  // Di luar cooldown → alert baru, bukan reopen.
  const old = { ...resolved, resolved_at: new Date(T0 - 60 * MIN).toISOString() };
  const fresh = planAlertChanges([item], [old], { at: new Date(T0).toISOString() });
  assert.equal(fresh[0].op, 'create');
});

// --- 15. Backend restart saat alert masih aktif ---------------------------------
test('skenario 15: restart tidak menggandakan alert dan tidak menghapus histori', () => {
  const open = { id: 11, rule_id: 'ap.memory.high', device_id: DEVICE.id, status: 'active', dedup_key: KEY('ap.memory.high'), first_seen_at: new Date(T0 - 10 * MIN).toISOString(), last_seen_at: new Date(T0 - 5 * MIN).toISOString() };
  const item = { rule_id: 'ap.memory.high', device_id: DEVICE.id, target: null, active: true, since: open.first_seen_at, evidence: { metric: 'memory_used_percent' }, dedup_key: KEY('ap.memory.high') };

  const afterRestart = planAlertChanges([item], [open], { at: new Date(T0).toISOString() });
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0].op, 'touch');
  assert.equal(afterRestart[0].id, 11);

  // Baru saja diperbarui → tidak ada operasi sama sekali (idempoten).
  const recent = { ...open, last_seen_at: new Date(T0 - 10_000).toISOString() };
  assert.deepEqual(planAlertChanges([item], [recent], { at: new Date(T0).toISOString() }), []);

  // Kondisi pulih → baris lama resolve, bukan dihapus.
  const resolveOps = planAlertChanges([{ ...item, active: false, since: null }], [open], { at: new Date(T0).toISOString() });
  assert.equal(resolveOps.length, 1);
  assert.equal(resolveOps[0].op, 'resolve');
  assert.equal(resolveOps[0].id, 11);
});

// --- 16. Dua evaluasi berjalan bersamaan (bagian murni) -------------------------
test('skenario 16: perencanaan idempoten — evaluasi kedua atas state hasil pertama tidak menambah alert', () => {
  const item = { rule_id: 'ap.unreachable', device_id: DEVICE.id, target: null, active: true, since: sec(0), evidence: {}, dedup_key: KEY('ap.unreachable') };
  const at = new Date(T0).toISOString();

  const first = planAlertChanges([item], [], { at });
  assert.equal(first[0].op, 'create');

  // State setelah evaluasi pertama (baris baru, dedup_key sama).
  const inserted = { id: 21, rule_id: 'ap.unreachable', device_id: DEVICE.id, status: 'active', dedup_key: KEY('ap.unreachable'), first_seen_at: sec(0), last_seen_at: at };
  const second = planAlertChanges([item], [inserted], { at });
  assert.deepEqual(second, []);

  // UNIQUE open_key menolak percobaan kedua yang tetap lolos (jaring terakhir).
  assert.equal(inserted.dedup_key, item.dedup_key);
});

// --- 18. Data stale tidak menyebabkan alert client palsu -------------------------
test('skenario 18: snapshot client kedaluwarsa tidak membuat alert client', () => {
  const mac = 'aa:bb:cc:00:00:05';
  // Snapshot terakhir 10 menit lalu: di luar maxDataAgeMs.client (3 menit).
  const stalePoints = [720, 660, 600].map((ago) => point(ago, [client(mac)]));
  const staleFindings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: stalePoints, alerts: new Map(), apEvaluable: true });
  assert.deepEqual(staleFindings, []);

  // Baris sistem kedaluwarsa: client tidak dinilai sama sekali meski ada alert terbuka.
  const openAlert = new Map([[KEY('client.signal.weak', DEVICE.id, mac), { id: 30, rule_id: 'client.signal.weak', device_id: DEVICE.id, target: mac, dedup_key: KEY('client.signal.weak', DEVICE.id, mac), first_seen_at: sec(900), last_seen_at: sec(600) }]]);
  const notEvaluable = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: [point(0, [])], alerts: openAlert, apEvaluable: false });
  assert.deepEqual(notEvaluable, []);

  // Data sistem kedaluwarsa juga tidak menutup alert client yang sudah terbuka:
  // engine hanya berhenti menilai, sehingga baris lama bertahan sampai data segar.
  const staleSystem = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: [systemRow(900)] }).findings;
  assert.equal(isActive(staleSystem, 'ap.metrics.stale'), true);
});

// --- Aturan tambahan yang mudah salah -------------------------------------------
test('gerbang kesegaran: data terlalu tua menahan rule (hold), bukan menutup alert', () => {
  const open = { id: 40, rule_id: 'ap.memory.high', device_id: DEVICE.id, status: 'active', dedup_key: KEY('ap.memory.high'), first_seen_at: sec(900), last_seen_at: sec(600) };
  const findings = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: [systemRow(900, { memory_used_percent: 95 })], alerts: [open] }).findings;
  // Rule tidak dinilai sama sekali saat data sistem kedaluwarsa (tidak ada temuan palsu)…
  assert.equal(findingOf(findings, 'ap.memory.high'), null);
  // …dan tanpa temuan, alert terbuka tidak disentuh: "tidak ada data" ≠ "pulih".
  assert.deepEqual(planAlertChanges(findings, [open], { at: sec(0) }).filter((op) => op.desired.rule_id === 'ap.memory.high'), []);
});

test('client.traffic_stalled: counter diam + sinyal lemah pada 5 snapshot', () => {
  const mac = 'aa:bb:cc:00:00:06';
  const stalled = [240, 180, 120, 60, 0].map((ago) => point(ago, [client(mac, -72, 5000)]));
  const findings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: stalled, alerts: new Map(), apEvaluable: true });
  assert.equal(isActive(findings, 'client.traffic_stalled', mac), true);
  assert.equal(findingOf(findings, 'client.traffic_stalled', mac).evidence.unchanged_snapshots, 5);

  // 3 snapshot diam (idle sesaat) belum cukup: itu penyebab flap alert ini.
  const short = [120, 60, 0].map((ago) => point(ago, [client(mac, -72, 5000)]));
  const shortFindings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: short, alerts: new Map(), apEvaluable: true });
  assert.equal(isActive(shortFindings, 'client.traffic_stalled', mac), false);

  const moving = [240, 180, 120, 60, 0].map((ago, index) => point(ago, [client(mac, -72, 5000 + index * 100)]));
  const movingFindings = evaluateClientRules({ atMs: T0, deviceId: DEVICE.id, points: moving, alerts: new Map(), apEvaluable: true });
  assert.equal(isActive(movingFindings, 'client.traffic_stalled', mac), false);
});

test('status acknowledged tidak diturunkan oleh touch dan tetap auto-resolve', () => {
  const acked = { id: 50, rule_id: 'ap.memory.high', device_id: DEVICE.id, status: 'acknowledged', dedup_key: KEY('ap.memory.high'), first_seen_at: sec(900), last_seen_at: sec(300) };
  const item = { rule_id: 'ap.memory.high', device_id: DEVICE.id, target: null, active: true, since: sec(900), evidence: {}, dedup_key: KEY('ap.memory.high') };
  const ops = planAlertChanges([item], [acked], { at: new Date(T0).toISOString() });
  assert.equal(ops[0].op, 'touch');

  const resolvedOps = planAlertChanges([{ ...item, active: false }], [acked], { at: new Date(T0).toISOString() });
  assert.equal(resolvedOps[0].op, 'resolve');
});

test('korelasi collector menahan alert per-AP pada tingkat engine', () => {
  const correlations = correlateAlerts({
    atMs: T0,
    alerts: [{ rule_id: 'ap.unreachable', device_id: 1, target: null }, { rule_id: 'ap.unreachable', device_id: 2, target: null }],
    devices: [
      { id: 1, stale: true, client_count: null },
      { id: 2, stale: true, client_count: null },
    ],
    collectorAgeMs: 300_000,
  });
  assert.equal(correlations.filter((c) => c.rule_id === 'incident.collector').length, 1);
  // AP yang stale tidak diangkat sebagai insiden AP tersendiri.
  assert.equal(correlations.some((c) => c.rule_id === 'incident.ap'), false);
});

test('ambang alert terdefinisi lengkap dan konsisten', () => {
  for (const [ruleId, meta] of Object.entries(ALERT_RULES)) {
    assert.ok(['critical', 'warning', 'info'].includes(meta.severity), `${ruleId} severity`);
    assert.ok(typeof meta.title === 'string' && meta.title.length > 0, `${ruleId} title`);
    assert.ok(typeof meta.kind === 'string', `${ruleId} kind`);
    if (meta.kind === 'threshold') {
      assert.ok(meta.threshold > 0 || meta.direction === 'below', `${ruleId} threshold`);
      assert.ok(meta.minDurationMs > 0 && meta.recoverDurationMs > 0, `${ruleId} durasi`);
      assert.ok(['ping', 'system', 'client'].includes(meta.source), `${ruleId} source`);
  }
  }
  assert.equal(ALERT.clientGoneSnapshots >= 2, true);
  assert.equal(ALERT.apFlapping.transitions >= 2, true);
});

// --- Link ethernet + radio (mca-dump) -------------------------------------------
// Deret sampel tiap 60 s; nilai tetap (hold) untuk menguji durasi.
const series = (spanSec, values) => Array.from({ length: spanSec / 60 + 1 }, (_, i) => systemRow(spanSec - i * 60, typeof values === 'function' ? values(i) : values));

test('ap.link.speed_low: link 100 Mbps ≥5 menit → aktif; 1000 Mbps → tidak', () => {
  const lambat = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(360, { eth_speed_mbps: 100, eth_full_duplex: 1 }) }).findings;
  assert.equal(isActive(lambat, 'ap.link.speed_low'), true);
  assert.equal(findingOf(lambat, 'ap.link.speed_low').evidence.full_duplex, 1);

  const cepat = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(360, { eth_speed_mbps: 1000, eth_full_duplex: 1 }) }).findings;
  assert.equal(isActive(cepat, 'ap.link.speed_low'), false);
});

test('ap.link.speed_low: null/kedaluwarsa menahan (hold), bukan menutup alert', () => {
  const hilang = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(360, { eth_speed_mbps: null }) }).findings;
  assert.equal(findingOf(hilang, 'ap.link.speed_low'), null, 'tanpa data rule tidak dinilai');

  const terbuka = [{ dedup_key: KEY('ap.link.speed_low'), rule_id: 'ap.link.speed_low', device_id: DEVICE.id, target: null, first_seen_at: sec(900), status: 'open' }];
  const hold = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(360, { eth_speed_mbps: null }), alerts: terbuka }).findings;
  assert.equal(findingOf(hold, 'ap.link.speed_low'), null, 'hold: alert lama dibiarkan apa adanya');

  // Data tua juga hold.
  const tua = deviceEval({ atMs: T0, pingHistory: [], systemHistory: [systemRow(3600, { eth_speed_mbps: 100 })] }).findings;
  assert.equal(findingOf(tua, 'ap.link.speed_low'), null);
});

test('ap.link.errors: naik 2 sampel beruntun → aktif; counter reset (turun) bukan kenaikan', () => {
  const naik = (...pairs) => pairs.map(([ago, rx, tx]) => systemRow(ago, { eth_rx_errors: rx, eth_tx_errors: tx }));
  const error = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: naik([300, 0, 0], [240, 0, 0], [180, 1, 0], [120, 1, 0], [60, 2, 3], [0, 2, 3]) }).findings;
  const opened = findingOf(error, 'ap.link.errors');
  assert.equal(opened.active, true);
  assert.equal(opened.evidence.increases, 2);
  assert.equal(opened.evidence.added_errors, 5); // rx +1, lalu rx +1 dan tx +3

  const reset = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: naik([300, 500, 500], [240, 1, 0], [180, 2, 0], [120, 2, 0], [60, 2, 0], [0, 2, 0]) }).findings;
  assert.equal(findingOf(reset, 'ap.link.errors').active, false, 'turun = reboot, bukan lonjakan error');

  const tanam = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: naik([120, 5, 5], [60, 5, 5], [0, 5, 5]) }).findings;
  assert.equal(findingOf(tanam, 'ap.link.errors').active, false, 'counter diam → tidak aktif');

  // Tanpa data link → rule tidak dinilai (hold), bukan resolve.
  const tanpaData = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: [systemRow(0, {})] }).findings;
  assert.equal(findingOf(tanpaData, 'ap.link.errors'), null);
});

test('ap.radio.ng.busy: cu_total 80 ≥10 menit → aktif, dengan channel di evidence', () => {
  const findings = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(660, { radio_ng_cu_total: 80, radio_ng_channel: 6 }) }).findings;
  const busy = findingOf(findings, 'ap.radio.ng.busy');
  assert.equal(busy.active, true);
  assert.equal(busy.evidence.channel, 6);
  assert.equal(busy.evidence.radio, '2,4 GHz');

  const singkat = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(300, { radio_ng_cu_total: 80 }) }).findings;
  assert.equal(isActive(singkat, 'ap.radio.ng.busy'), false, '10 menit belum terpenuhi');

  // Band 5 GHz terpisah: 5 GHz tenang tidak memicu rule na.
  const na = deviceEval({ pingHistory: [pingRow(0, 1)], systemHistory: series(660, { radio_na_cu_total: 20, radio_na_cu_interf: null }) }).findings;
  assert.equal(isActive(na, 'ap.radio.na.busy'), false);
  assert.equal(isActive(na, 'ap.radio.na.interference'), false, 'null tidak dinilai');
  assert.equal(activeRules(na).includes('ap.radio.na.busy'), false);
});

test('korelasi: alert link/radio dihitung sebagai indikator resource AP', () => {
  const correlations = correlateAlerts({
    atMs: T0,
    alerts: [
      { rule_id: 'ap.link.speed_low', device_id: DEVICE.id, target: null },
      { rule_id: 'client.signal.weak', device_id: DEVICE.id, target: 'aa:bb:cc:00:00:0a' },
    ],
    devices: [{ id: DEVICE.id, stale: false, client_count: 3 }],
    collectorAgeMs: 1000,
  });
  const scenarioA = correlations.find((c) => c.rule_id === 'incident.ap');
  assert.ok(scenarioA, 'skenario A harus muncul');
  const sources = scenarioA.diagnosis.indicators.map((i) => i.source);
  assert.deepEqual([...sources].sort(), ['ap_resources', 'clients']);
  assert.deepEqual(scenarioA.diagnosis.indicators.find((i) => i.source === 'ap_resources').detail.rules, ['ap.link.speed_low']);
  assert.ok(scenarioA.diagnosis.evidence_missing.includes('Counter port switch sisi uplink'));
});
