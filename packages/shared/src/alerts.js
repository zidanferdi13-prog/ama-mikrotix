// Rule engine alert §5–§6 — murni: tanpa I/O, tanpa jaringan, tanpa jam.
// Lapisan DB hanya mengubah op → SQL (apps/collector/src/alerts-job.js), sehingga
// seluruh keputusan alert bisa diuji dengan data mock.
import { ALERT, ALERT_RULES } from './constants.js';

export const ALERT_STATUS = { active: 'active', acknowledged: 'acknowledged', resolved: 'resolved' };

// Kegagalan SSH yang butuh tindakan operator, bukan gejala jaringan.
export const CONFIG_CODES = ['no_secret', 'host_key_changed', 'host_key_unpinned'];
// Sumber rule → kunci kesegaran di ALERT.maxDataAgeMs.
const MAX_AGE_SOURCE = { ping: 'ping', system: 'metric', client: 'client' };
// Toleransi pencocokan waktu: DATETIME(3) sudah presisi, tetapi pembulatan jam proses
// membuat perbandingan tepat-menempel rapuh.
const TOLERANCE_MS = 50;

export function alertDedupKey({ rule_id, device_id = null, target = null }) {
  return `${rule_id}|${device_id ?? ''}|${target ?? ''}`;
}

function ms(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

function valueOf(row, metric) {
  return metric === 'signal_dbm' ? row.signal_dbm : row[metric];
}

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(n, digits = 3) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(digits));
}

function trailingStreak(rows, predicate) {
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!predicate(rows[i])) break;
    n += 1;
  }
  return n;
}

// Rentang sampel terakhir yang terus-menerus memenuhi predikat.
function trailingRun(series, predicate) {
  let start = series.length;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (!predicate(series[i])) break;
    start = i;
  }
  const rows = series.slice(start);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    samples: rows.length,
    since: first ? first.observed_at : null,
    span_ms: first && last ? ms(last.observed_at) - ms(first.observed_at) : 0,
  };
}

function lastStreakStart(rows, length, predicate) {
  for (let end = rows.length; end >= length; end -= 1) {
    const slice = rows.slice(end - length, end);
    if (slice.every(predicate)) return slice[0].observed_at;
  }
  return null;
}

// Ambang generik §5: threshold + min duration, recovery threshold + recovery duration.
// Gerbang kesegaran hanya pada sampel TERAKHIR: bila data terbaru lebih tua dari
// maxDataAgeMs, rule tidak dinilai (`hold`) sehingga alert terbuka tidak ditutup oleh
// data yang hilang — "tidak ada data" ≠ "pulih".
export function evaluateThreshold(ruleId, rows, { atMs, open = null, windowMs = ALERT.deviceWindowMs } = {}) {
  const meta = ALERT_RULES[ruleId];
  if (!meta || meta.kind !== 'threshold') throw new Error(`not_a_threshold_rule:${ruleId}`);
  // Sumber rule ≠ kunci maxDataAgeMs: rule sistem memakai kunci `metric`.
  const maxAgeMs = ALERT.maxDataAgeMs[MAX_AGE_SOURCE[meta.source] ?? meta.source];
  // `!= null` (bukan `!== null`) menahan undefined juga: nilai hilang ≠ nilai nol.
  const series = (rows ?? [])
    .filter((row) => ms(row.observed_at) !== null && valueOf(row, meta.metric) != null)
    .sort((a, b) => ms(a.observed_at) - ms(b.observed_at))
    .filter((row) => atMs - ms(row.observed_at) <= windowMs + TOLERANCE_MS);

  const evidenceBase = {
    metric: meta.metric,
    source: meta.source,
    direction: meta.direction,
    threshold: meta.threshold,
    recover_threshold: meta.recover,
    min_duration_ms: meta.minDurationMs,
    recover_duration_ms: meta.recoverDurationMs,
    max_data_age_ms: maxAgeMs,
  };
  const last = series[series.length - 1];
  const lastAgeMs = last ? atMs - ms(last.observed_at) : null;
  if (!last || lastAgeMs < -TOLERANCE_MS || lastAgeMs > maxAgeMs + TOLERANCE_MS) {
    return { evaluated: false, active: Boolean(open), reason: 'no_data', since: open?.first_seen_at ?? null, evidence: { ...evidenceBase, samples: series.length, latest_sample_age_ms: lastAgeMs } };
  }

  const values = series.map((row) => valueOf(row, meta.metric));
  const breaching = (v) => (meta.direction === 'above' ? v > meta.threshold : v < meta.threshold);
  const recovered = (v) => (meta.direction === 'above' ? v <= meta.recover : v >= meta.recover);
  const breachRun = trailingRun(series, (row) => breaching(valueOf(row, meta.metric)));
  const recoverRun = trailingRun(series, (row) => recovered(valueOf(row, meta.metric)));

  const evidence = {
    ...evidenceBase,
    samples: series.length,
    latest_sample_age_ms: round(lastAgeMs, 0),
    latest: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    average: round(values.reduce((a, b) => a + b, 0) / values.length),
    first_sample_at: series[0].observed_at,
    last_sample_at: last.observed_at,
    breaching_samples: values.filter(breaching).length,
    breach_run_ms: breachRun.span_ms,
    breach_run_samples: breachRun.samples,
    recover_run_ms: recoverRun.span_ms,
  };

  // Kondisi bertahan cukup lama → aktif; pulih Bertahan cukup lama → resolve.
  if (breachRun.span_ms >= meta.minDurationMs - TOLERANCE_MS) {
    return { evaluated: true, active: true, reason: 'open', since: open?.first_seen_at ?? breachRun.since, evidence };
  }
  if (recoverRun.span_ms >= meta.recoverDurationMs - TOLERANCE_MS) {
    return { evaluated: true, active: false, reason: 'recovered', since: null, evidence };
  }
  // Naik-turun di antara dua durasi minimum: pertahankan keadaan sebelumnya.
  return { evaluated: true, active: Boolean(open), reason: 'hold', since: open?.first_seen_at ?? null, evidence };
}

// Uptime turun tajam antara dua sampel sukses → perangkat restart.
export function detectReboots(systemRows) {
  const events = [];
  let prev = null;
  for (const row of systemRows) {
    const up = row.uptime_seconds === null || row.uptime_seconds === undefined ? null : Number(row.uptime_seconds);
    const at = row.observed_at;
    if (up === null || ms(at) === null) continue;
    if (prev && up < prev.up - ALERT.reboot.minDropSeconds) {
      events.push({ detected_at: at, previous_sample_at: prev.at, uptime_before_s: prev.up, uptime_after_s: up });
    }
    prev = { up, at };
  }
  return events;
}

function lastValue(rows, field) {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i][field] != null) return rows[i][field];
  return null;
}

// Internet dari AP: hanya sampel yang benar-benar terukur (sukses, DNS gagal, 100% loss)
// yang dinilai. SSH gagal/timeout = tidak diketahui → dilewati, bukan bukti internet mati.
const INTERNET_DOWN_CODES = ['dns_failed', 'no_reply'];
export function detectInternetDown(systemRows, atMs) {
  const rows = systemRows.filter((r) => ms(r.observed_at) !== null && (r.internet_status === 'ok' || INTERNET_DOWN_CODES.includes(r.internet_code)));
  const last = rows[rows.length - 1];
  if (!last || atMs - ms(last.observed_at) > ALERT.maxDataAgeMs.metric + TOLERANCE_MS) return { evaluated: false };
  const down = (r) => r.internet_status !== 'ok';
  const streak = trailingStreak(rows, down);
  return {
    evaluated: true,
    active: streak >= ALERT.internetFailures,
    since: streak ? rows[rows.length - streak].observed_at : null,
    evidence: {
      kind: 'internet',
      source: 'system',
      code: down(last) ? last.internet_code : null,
      consecutive_failures: streak,
      threshold: ALERT.internetFailures,
      checks: rows.slice(-3).map((r) => ({ observed_at: r.observed_at, code: r.internet_code ?? null, latency_ms: r.internet_latency_ms ?? null, loss_percent: r.internet_loss_percent ?? null })),
      note: 'Ping google.com dijalankan DI AP lewat SSH. AP terjangkau dari server, tetapi tidak bisa ke internet.',
      next_steps: last.internet_code === 'dns_failed'
        ? ['Cek DNS yang diterima AP (DHCP/static)', 'Cek DNS server/gateway', 'Uji nslookup google.com dari jaringan yang sama']
        : ['Cek gateway/default route AP', 'Cek uplink internet kantor', 'Cek firewall yang memblok ICMP keluar'],
    },
  };
}

// Counter error ethernet (rx+tx) kumulatif: hitung interval sampel yang naik. Turun = counter
// reset (reboot) → diabaikan, bukan kenaikan negatif. Data hilang/tua → tidak dinilai (hold).
export function detectLinkErrors(systemRows, atMs) {
  const rows = systemRows
    .filter((r) => ms(r.observed_at) !== null && r.eth_rx_errors != null && r.eth_tx_errors != null)
    .map((r) => ({ at: r.observed_at, total: Number(r.eth_rx_errors) + Number(r.eth_tx_errors) }));
  const last = rows[rows.length - 1];
  if (rows.length < 2 || atMs - ms(last.at) > ALERT.maxDataAgeMs.metric + TOLERANCE_MS) return { evaluated: false };
  const increases = [];
  for (let i = 1; i < rows.length; i += 1) {
    const delta = rows[i].total - rows[i - 1].total;
    if (delta > 0) increases.push({ at: rows[i].at, delta });
  }
  return {
    evaluated: true,
    active: increases.length >= ALERT.linkErrors.minIncreases,
    since: increases[0]?.at ?? null,
    evidence: {
      kind: 'link_errors',
      increases: increases.length,
      threshold: ALERT.linkErrors.minIncreases,
      added_errors: increases.reduce((a, b) => a + b.delta, 0),
      latest_total: last.total,
      samples: rows.length,
      window_ms: ALERT.deviceWindowMs,
      next_steps: ['Ganti/periksa kabel dan konektor uplink AP', 'Cek counter error di port switch', 'Coba port switch lain'],
      note: 'Counter rx/tx_errors kumulatif sejak boot; turun berarti AP reboot dan diabaikan.',
    },
  };
}

// Baseline = median sampel lebih tua dari recentMs (≤ windowMs); recent = median recentMs terakhir.
export function detectClientCountChange(counts, atMs) {
  const cfg = ALERT.clientCount;
  const recent = counts.filter((c) => atMs - c.at <= cfg.recentMs + TOLERANCE_MS);
  const baseline = counts.filter((c) => atMs - c.at > cfg.recentMs && atMs - c.at <= cfg.windowMs + TOLERANCE_MS);
  const baseValue = median(baseline.map((c) => c.count));
  const recentValue = median(recent.map((c) => c.count));
  const result = {
    baseline: round(baseValue, 1),
    recent: round(recentValue, 1),
    baseline_samples: baseline.length,
    recent_samples: recent.length,
    drop: null,
    spike: null,
  };
  // Baseline terlalu kecil: selisih 1–2 client bukan sinyal.
  if (baseValue === null || recentValue === null || baseValue < cfg.minBaseline) return result;

  const dropLine = baseValue * (1 - cfg.dropRatio);
  if (recentValue <= dropLine) {
    const hit = recent.find((c) => c.count <= dropLine);
    result.drop = { since: hit ? new Date(hit.at).toISOString() : null, ratio: round(recentValue / baseValue), baseline: round(baseValue, 1), recent: round(recentValue, 1) };
  }
  const spikeLine = baseValue * (1 + cfg.spikeRatio);
  if (recentValue >= spikeLine) {
    const hit = recent.find((c) => c.count >= spikeLine);
    result.spike = { since: hit ? new Date(hit.at).toISOString() : null, ratio: round(recentValue / baseValue), baseline: round(baseValue, 1), recent: round(recentValue, 1) };
  }
  return result;
}

// Kegagalan SSH beruntun: satu sampel sistem = satu percobaan SSH, jadi rantai kegagalan
// dihitung dari sampel sistem yang benar-benar dijalankan.
export function sshState({ atMs, pingKnown, pingDown, metrics = {} }) {
  const samples = (metrics.systemSamples ?? [])
    .filter((s) => ms(s.observed_at) !== null && atMs - ms(s.observed_at) <= ALERT.deviceWindowMs)
    .sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  const code = last.ssh?.code ?? null;
  if (!code) return null;
  // Ping mati → kegagalan SSH tidak menambah informasi apa pun.
  if (!pingKnown || pingDown) return { code, failCount: 0, firstFailAt: null, lastFailAt: last.observed_at, suppressed: true };

  let failCount = 0;
  let firstFailAt = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].ssh?.status === 'ok') break; // sesi SSH sukses → rantai kegagalan berhenti
    if ((samples[i].ssh?.code ?? null) !== code) break;
    failCount += 1;
    firstFailAt = samples[i].observed_at;
  }
  return { code, failCount, firstFailAt, lastFailAt: last.observed_at };
}

// alerts: Map dedup_key → baris alert terbuka (active/acknowledged).
// metrics: { ping: {observed_at, reachable, code, history[]}, system: {…, history[], collection_status} }
// metrics.systemSamples: [{observed_at, ssh:{ok, code}}]
export function evaluateDeviceRules({ atMs, device, metrics = {}, events = [], alerts = new Map() }) {
  const ping = metrics.ping ?? null;
  const system = metrics.system ?? null;
  const pingAt = ms(ping?.observed_at);
  const pingAgeMs = pingAt === null ? null : atMs - pingAt;
  const pingKnown = pingAgeMs !== null && pingAgeMs >= -TOLERANCE_MS && pingAgeMs <= ALERT.maxDataAgeMs.ping + TOLERANCE_MS;
  const pingDown = ping?.reachable === 0;
  const pingRows = Array.isArray(ping?.history) ? ping.history : [];
  // Hysteresis mengikuti transisi existing (TRANSITION.downAfterFailures) + penjaga tiga
  // sampel beruntun: satu paket hilang tidak membuat AP dianggap offline.
  const pingRollingDown = pingRows.length >= 3 && pingRows.slice(-3).every((r) => r.reachable === 0);

  const systemAgeMs = system ? atMs - (ms(system.observed_at) ?? 0) : null;
  const systemStale = Boolean(system) && systemAgeMs > ALERT.maxDataAgeMs.metric;
  const systemRows = Array.isArray(system?.history) ? system.history : [];
  const ssh = sshState({ atMs, pingKnown, pingDown, metrics });

  const findings = [];
  const openOf = (rule_id, target = null) => alerts.get(alertDedupKey({ rule_id, device_id: device.id, target })) ?? null;
  const push = (rule_id, active, since, evidence, diagnosis = null) =>
    findings.push({ rule_id, active: Boolean(active), since: active ? since : null, evidence, diagnosis });

  // --- §5.1 Availability -----------------------------------------------------
  if (!pingKnown) {
    // Kondisi "tidak dapat diverifikasi" punya kondisi pulih alami: data segar kembali.
    push('ap.collector_stalled', true, openOf('ap.collector_stalled')?.first_seen_at ?? ping?.observed_at ?? null, {
      kind: 'collector',
      ping_age_ms: pingAgeMs,
      stale_after_ms: ALERT.maxDataAgeMs.ping,
      note: 'Tidak ada pemeriksaan ping baru: kondisi AP tidak dapat diverifikasi.',
    });
  } else if (ping?.reachable === null || ping?.reachable === undefined) {
    // Pemeriksaan tidak sempat jalan (timeout internal): bukan bukti apa pun.
    push('ap.unverified', true, openOf('ap.unverified')?.first_seen_at ?? ping.observed_at, {
      kind: 'unknown',
      code: ping.code ?? null,
      ping_age_ms: pingAgeMs,
      note: 'Pemeriksaan ping tidak menghasilkan data; offline tidak dapat disimpulkan.',
    });
  } else {
    push('ap.collector_stalled', false, null, { kind: 'collector', ping_age_ms: pingAgeMs });
    push('ap.unverified', false, null, { kind: 'unknown' });
    push('ap.unreachable', pingDown && pingRollingDown, lastStreakStart(pingRows, 3, (r) => r.reachable === 0), {
      kind: 'availability',
      source: 'ping',
      checks: pingRows.slice(-3).map((r) => ({ observed_at: r.observed_at, reachable: r.reachable, latency_ms: r.latency_ms ?? null })),
      consecutive_failures: trailingStreak(pingRows, (r) => r.reachable === 0),
      ping_age_ms: pingAgeMs,
      next_steps: ['Cek daya PoE/adaptor dan indikator LED AP', 'Cek kabel serta port switch uplink', 'Uji ping manual dari host collector'],
      note: 'Kesimpulan hanya dari ping ICMP, bukan dari kegagalan SSH.',
    });

    // SSH: ping hidup tetapi sesi SSH gagal. Auth gagal TIDAK PERNAH jadi ap.unreachable.
    const sshCode = ssh?.code ?? null;
    const sshBroken = Boolean(ssh) && (CONFIG_CODES.includes(sshCode) || ssh.failCount >= ALERT.sshFailures);
    if (sshCode === 'auth_failed' || sshCode === 'timeout') {
      const ruleId = sshCode === 'auth_failed' ? 'ap.ssh.auth_failed' : 'ap.ssh.unavailable';
      push(ruleId, sshBroken, openOf(ruleId)?.first_seen_at ?? ssh.firstFailAt, {
        kind: 'ssh',
        code: sshCode,
        consecutive_failures: ssh.failCount,
        sustained_ms: ssh.firstFailAt ? atMs - ms(ssh.firstFailAt) : null,
        last_error_at: ssh.lastFailAt,
        ping_age_ms: pingAgeMs,
        ping_ok: true,
        note: 'AP tetap dianggap online: SSH gagal bukan bukti AP offline.',
        next_steps: sshCode === 'auth_failed'
          ? ['Cek ulang kredensial SSH yang tersimpan', 'Pastikan user SSH masih aktif di AP', 'Uji ssh manual dari host collector']
          : ['Cek service SSH/daemon di AP', 'Cek jalur TCP 22 dari host collector', 'Uji ssh manual dari host collector'],
      });
    }
    if (ssh && CONFIG_CODES.includes(sshCode)) {
      // no_secret/host_key bukan gejala jaringan: butuh tindakan operator, tidak pulih sendiri.
      push('ap.ssh.config', true, openOf('ap.ssh.config')?.first_seen_at ?? ssh.firstFailAt, {
        kind: 'ssh',
        code: sshCode,
        consecutive_failures: ssh.failCount,
        note: 'Konfigurasi belum siap; koleksi metrik tidak akan berjalan sampai diperbaiki.',
        next_steps: sshCode === 'no_secret'
          ? ['Isi kredensial SSH AP di dashboard']
          : ['Verifikasi fingerprint host key AP sebelum menyimpan ulang'],
      });
    }

    // Metrik sistem kedaluwarsa padahal ping hidup → masalah SSH/koleksi, bukan AP mati.
    push('ap.metrics.stale', !pingDown && systemStale, openOf('ap.metrics.stale')?.first_seen_at ?? system?.observed_at, {
      kind: 'stale',
      source: 'system',
      system_age_ms: systemAgeMs,
      stale_after_ms: ALERT.maxDataAgeMs.metric,
      last_collection_status: system?.collection_status ?? null,
      ssh_code: sshCode,
      note: 'Data sistem yang tua berarti pengumpulan metrik bermasalah, bukan AP offline.',
    });
  }

  // Down → up berulang, dihitung dari monitoring_events yang sudah ada (tanpa tabel baru).
  const flaps = events
    .filter((e) => e.type === 'device.status.changed' && ms(e.started_at) !== null && atMs - ms(e.started_at) <= ALERT.apFlapping.windowMs)
    .sort((a, b) => ms(a.started_at) - ms(b.started_at));
  push('ap.flapping', flaps.length >= ALERT.apFlapping.transitions, flaps[0]?.started_at ?? null, {
    kind: 'flapping',
    transitions: flaps.length,
    threshold: ALERT.apFlapping.transitions,
    window_ms: ALERT.apFlapping.windowMs,
    events: flaps.slice(-6).map((e) => ({ at: e.started_at, transition: e.detail?.transition ?? null })),
    next_steps: ['Cek stabilitas daya PoE', 'Cek kualitas kabel/port uplink', 'Cek log AP untuk restart berulang'],
  });

  // --- §5.2 Performance ------------------------------------------------------
  const systemHistory = systemRows.filter((r) => ms(r.observed_at) !== null && atMs - ms(r.observed_at) <= ALERT.deviceWindowMs + TOLERANCE_MS);
  // Latency = RTT AP → google.com dari sampel sistem (SSH), bukan ping collector → AP.
  for (const ruleId of ['ap.latency.high', 'ap.latency.critical']) {
    const res = evaluateThreshold(ruleId, systemHistory, { atMs, open: openOf(ruleId) });
    if (!res.evaluated) continue;
    push(ruleId, res.active, res.since, { ...res.evidence, note: 'Latency = RTT ICMP AP → google.com (diukur di AP lewat SSH).' });
  }
  const internet = detectInternetDown(systemHistory, atMs);
  if (internet.evaluated) push('ap.internet.down', internet.active, openOf('ap.internet.down')?.first_seen_at ?? internet.since, internet.evidence);

  for (const ruleId of ['ap.memory.high', 'ap.load.high']) {
    const res = evaluateThreshold(ruleId, systemHistory, { atMs, open: openOf(ruleId) });
    if (!res.evaluated) continue;
    const extra = ruleId === 'ap.load.high' ? { note: 'Load absolut karena jumlah CPU AP belum dikumpulkan; verifikasi manual bila alert sering muncul.' } : {};
    push(ruleId, res.active, res.since, { ...res.evidence, ...extra });
  }

  // Link ethernet: kecepatan negosiasi + counter error. rx_dropped hanya tampil di dashboard:
  // pada Linux counter itu sering menghitung frame VLAN/protokol tak dikenal, bukan gangguan.
  // ponytail: bila nanti perlu, rx_dropped bisa dinilai sebagai info dengan ambang laju.
  const speedRule = evaluateThreshold('ap.link.speed_low', systemHistory, { atMs, open: openOf('ap.link.speed_low') });
  if (speedRule.evaluated) {
    push('ap.link.speed_low', speedRule.active, speedRule.since, {
      ...speedRule.evidence,
      full_duplex: lastValue(systemHistory, 'eth_full_duplex'),
      next_steps: ['Cek kabel dan port switch uplink AP', 'Pastikan port switch tidak dipaksa 100 Mbps', 'Cek kabel tertekuk/terlalu panjang'],
      note: 'Kecepatan negosiasi ethernet, bukan throughput Wi-Fi.',
    });
  }
  const linkErrors = detectLinkErrors(systemHistory, atMs);
  if (linkErrors.evaluated) push('ap.link.errors', linkErrors.active, openOf('ap.link.errors')?.first_seen_at ?? linkErrors.since, linkErrors.evidence);

  // Radio per band (ng = 2,4 GHz, na = 5 GHz): channel utilisation dan interferensi.
  for (const band of ['ng', 'na']) {
    const label = band === 'ng' ? '2,4 GHz' : '5 GHz';
    for (const kind of ['busy', 'interference']) {
      const ruleId = `ap.radio.${band}.${kind}`;
      const res = evaluateThreshold(ruleId, systemHistory, { atMs, open: openOf(ruleId) });
      if (!res.evaluated) continue;
      push(ruleId, res.active, res.since, {
        ...res.evidence,
        radio: label,
        channel: lastValue(systemHistory, `radio_${band}_channel`),
        note: kind === 'busy'
          ? `Channel utilisation ${label}: porsi waktu udara terpakai, termasuk AP lain dan sumber non-Wi-Fi.`
          : `Interferensi ${label}: porsi waktu udara terpakai sumber di luar AP ini.`,
        next_steps: kind === 'busy'
          ? ['Cek jumlah client aktif di band ini', 'Cek AP tetangga pada kanal sama', 'Pertimbangkan pindah kanal atau tambah AP']
          : ['Pindai kanal di sekitar lokasi', 'Pindah ke kanal yang lebih bersih', 'Cek sumber interferensi non-Wi-Fi'],
      });
    }
  }

  // Reboot = peristiwa: alert ditutup otomatis setelah TTL.
  const rebootEvents = detectReboots(systemHistory);
  const lastReboot = rebootEvents.length ? rebootEvents[rebootEvents.length - 1] : null;
  if (lastReboot) {
    push('ap.reboot', atMs - ms(lastReboot.detected_at) <= ALERT.reboot.ttlMs, openOf('ap.reboot')?.first_seen_at ?? lastReboot.detected_at, {
      kind: 'reboot',
      ...lastReboot,
      ttl_ms: ALERT.reboot.ttlMs,
      note: 'Uptime turun: AP restart. Bukan bukti kehilangan daya.',
    });
  } else if (openOf('ap.reboot')) {
    push('ap.reboot', false, null, { kind: 'reboot', note: 'Peristiwa reboot sudah keluar dari jendela pengamatan.' });
  }

  const counts = systemHistory
    .filter((r) => r.client_count !== null && r.client_count !== undefined)
    .map((r) => ({ at: ms(r.observed_at), count: Number(r.client_count) }));
  const change = detectClientCountChange(counts, atMs);
  push('ap.client_count.drop', Boolean(change.drop), change.drop?.since ?? null, {
    kind: 'client_count',
    ...change,
    window_ms: ALERT.clientCount.windowMs,
    recent_ms: ALERT.clientCount.recentMs,
    min_baseline: ALERT.clientCount.minBaseline,
    next_steps: ['Cek apakah wajar untuk jam ini (client pulang)', 'Cek radio/SSID yang dipakai', 'Bandingkan dengan AP lain di lokasi sama'],
    note: 'Turunnya jumlah client belum tentu gangguan; bandingkan dengan pola jam sibuk.',
  });
  push('ap.client_count.spike', Boolean(change.spike), change.spike?.since ?? null, {
    kind: 'client_count',
    ...change,
    window_ms: ALERT.clientCount.windowMs,
    recent_ms: ALERT.clientCount.recentMs,
    next_steps: ['Cek perangkat baru yang masuk', 'Cek kualitas layanan pada AP ini'],
  });

  return { findings, ssh };
}

// --- §5.3 Client -------------------------------------------------------------
// Client hilang→muncul hanya dihitung dari snapshot SUKSES: kegagalan koleksi bukan
// disconnect. Identitas = MAC + AP; IP tidak dipakai (bisa berubah).
// points: [{ observed_at, clients: [{mac, signal_dbm, tx_bytes, rx_bytes}] }]
export function evaluateClientRules({ atMs, deviceId, points = [], alerts = new Map(), apEvaluable = true, healthyClients = null, seenElsewhere = new Map() }) {
  // Data stale / AP tidak dapat diverifikasi → tidak ada alert client baru (dan alert
  // lama dibiarkan apa adanya).
  if (!apEvaluable) return [];
  const snapshots = points
    .filter((p) => ms(p.observed_at) !== null && atMs - ms(p.observed_at) <= ALERT.clientWindowMs + TOLERANCE_MS)
    .sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
  if (!snapshots.length) return [];
  const lastAt = ms(snapshots[snapshots.length - 1].observed_at);
  if (atMs - lastAt > ALERT.maxDataAgeMs.client + TOLERANCE_MS) return [];

  const macs = new Set();
  for (const p of snapshots) for (const c of p.clients ?? []) macs.add(c.mac);
  for (const key of alerts.keys()) {
    const [, devId, target] = key.split('|');
    if (Number(devId) === Number(deviceId) && target) macs.add(target);
  }

  const findings = [];
  for (const mac of macs) {
    const series = snapshots.map((p) => ({ observed_at: p.observed_at, client: (p.clients ?? []).find((c) => c.mac === mac) ?? null }));
    const openOf = (rule_id) => alerts.get(alertDedupKey({ rule_id, device_id: deviceId, target: mac })) ?? null;
    const push = (rule_id, active, since, evidence, diagnosis = null) =>
      findings.push({ rule_id, target: mac, active: Boolean(active), since: active ? since : null, evidence, diagnosis });

    const seen = series.filter((s) => s.client);
    const goneRun = trailingStreak(series, (s) => !s.client);
    const seenRun = trailingStreak(series, (s) => Boolean(s.client));
    const lastSeen = seen.length ? seen[seen.length - 1].observed_at : null;

    // Sinyal: hanya dari snapshot yang benar-benar memuat client ini.
    for (const ruleId of ['client.signal.weak', 'client.signal.critical']) {
      // Client tak terlihat sepanjang jendela = sudah pergi: sinyalnya tak bisa dinilai
      // lagi, jadi alert yang terbuka ditutup (sama dengan client.disconnected).
      if (seen.length === 0) {
        if (openOf(ruleId)) push(ruleId, false, null, { window_ms: ALERT.clientWindowMs, note: 'Client tidak terlihat sepanjang jendela evaluasi: dianggap sudah pergi, alert ditutup.' });
        continue;
      }
      const res = evaluateThreshold(ruleId, series.filter((s) => s.client && s.client.signal_dbm != null).map((s) => ({ observed_at: s.observed_at, signal_dbm: s.client.signal_dbm })), { atMs, open: openOf(ruleId), windowMs: ALERT.clientWindowMs });
      if (!res.evaluated) continue;
      push(ruleId, res.active, res.since, {
        ...res.evidence,
        seen_snapshots: seen.length,
        window_snapshots: series.length,
        note: 'Dasar perhitungan hanya snapshot yang memuat client ini.',
      }, diagnosisFor('client_rf', 'medium', { healthyClients, apHealthy: true, mac, lastSeenAt: lastSeen }));
    }

    // Disconnect hanya setelah N snapshot sukses beruntun tanpa client (bukan 1) DAN
    // client itu tidak terlihat di AP lain baru-baru ini (roaming ≠ hilang).
    const elsewhere = seenElsewhere.get(mac) ?? null;
    const roaming = elsewhere !== null && atMs - elsewhere.atMs <= ALERT.clientElsewhereMs;
    const goneRule = openOf('client.disconnected');
    // ponytail: client yang tak terlihat sepanjang clientWindowMs dianggap sudah pergi
    // (pulang/dimatikan) → alert ditutup, bukan menumpuk selamanya. Riwayat tetap ada.
    if (goneRule && seen.length === 0) {
      push('client.disconnected', false, null, {
        kind: 'client_disconnected',
        missing_snapshots: goneRun,
        window_ms: ALERT.clientWindowMs,
        note: 'Client tidak terlihat sepanjang jendela evaluasi: dianggap sudah pergi, alert ditutup.',
      });
    } else if (goneRun >= ALERT.clientGoneSnapshots && !roaming && seen.length > 0) {
      const goneSince = series[series.length - goneRun].observed_at;
      push('client.disconnected', true, goneRule?.first_seen_at ?? goneSince, {
        kind: 'client_disconnected',
        missing_snapshots: goneRun,
        threshold: ALERT.clientGoneSnapshots,
        last_seen_at: lastSeen,
        window_snapshots: series.length,
        next_steps: ['Cek apakah perangkat dimatikan atau berpindah AP', 'Cek riwayat flapping client ini'],
        note: 'Hilang pada satu snapshot bukan disconnect; butuh 2 snapshot sukses beruntun dan tidak terlihat di AP lain.',
      }, diagnosisFor('client_gone', 'medium', { healthyClients, apHealthy: true, mac, lastSeenAt: lastSeen }));
    } else if (goneRule && (seenRun >= 1 || roaming)) {
      push('client.disconnected', false, null, {
        kind: 'client_disconnected',
        missing_snapshots: goneRun,
        seen_again_at: seen.length ? seen[seen.length - 1].observed_at : null,
        last_seen_at: lastSeen,
        roaming_at: elsewhere === null ? null : iso(elsewhere.atMs),
        roaming_device_id: elsewhere?.deviceId ?? null,
        note: roaming ? 'Client terlihat di AP lain: roaming, bukan hilang.' : 'Client terlihat kembali pada snapshot terakhir.',
      });
    }

    const episodes = missingEpisodes(series);
    const flapRule = openOf('client.flapping');
    if (episodes.count >= ALERT.clientFlapping.episodes) {
      push('client.flapping', true, flapRule?.first_seen_at ?? episodes.firstAt, {
        kind: 'client_flapping',
        episodes: episodes.count,
        threshold: ALERT.clientFlapping.episodes,
        missing_snapshots: episodes.missing,
        window_ms: ALERT.clientFlapping.windowMs,
        note: 'Hanya snapshot sukses yang dihitung; kegagalan koleksi tidak menciptakan episode.',
      }, diagnosisFor('client_rf', episodes.count >= 5 ? 'high' : 'medium', { healthyClients, apHealthy: true, mac, lastSeenAt: lastSeen }));
    } else if (flapRule) {
      push('client.flapping', false, null, { kind: 'client_flapping', episodes: episodes.count, note: 'Episode hilang→muncul kembali sudah di bawah ambang.' });
    }

    const stall = stalledCounters(series);
    const stallRule = openOf('client.traffic_stalled');
    if (stall) {
      push('client.traffic_stalled', true, stallRule?.first_seen_at ?? stall.since, {
        kind: 'client_traffic',
        ...stall,
        note: 'Counter diam + sinyal lemah: indikasi, bukan bukti pasti (client bisa benar-benar idle).',
      }, diagnosisFor('client_rf', 'low', { healthyClients, apHealthy: true, mac, lastSeenAt: lastSeen }));
    } else if (stallRule) {
      push('client.traffic_stalled', false, null, { kind: 'client_traffic', note: 'Counter trafik client sudah bergerak lagi.' });
    }
  }
  return findings;
}

function missingEpisodes(series) {
  let count = 0;
  let missing = 0;
  let firstAt = null;
  let previous = null;
  for (const s of series) {
    const present = Boolean(s.client);
    if (!present) missing += 1;
    if (previous === false && present) {
      count += 1;
      if (!firstAt) firstAt = s.observed_at;
    }
    previous = present;
  }
  return { count, missing, firstAt };
}

// Trafik diam + sinyal lemah berulang: indikasi, bukan bukti (client bisa benar-benar idle).
function stalledCounters(series) {
  const cfg = ALERT.clientTrafficStalled;
  const tail = series.slice(-cfg.snapshots);
  if (tail.length < cfg.snapshots || tail.some((s) => !s.client)) return null;
  const bytes = tail.map((s) => (Number(s.client.tx_bytes) || 0) + (Number(s.client.rx_bytes) || 0));
  if (new Set(bytes).size !== 1) return null;
  const weak = tail.some((s) => s.client.signal_dbm != null && s.client.signal_dbm <= ALERT_RULES['client.signal.weak'].threshold);
  if (!weak) return null;
  return { since: tail[0].observed_at, unchanged_snapshots: tail.length, total_bytes: bytes[0], weak_signal: true };
}

export function diagnosisFor(kind, confidence, context = {}) {
  const table = {
    client_rf: {
      scenario: 'B',
      title: 'Kemungkinan masalah sisi client atau RF lokal',
      evidence_present: ['RSSI client dari snapshot berkala', 'Kondisi AP dan jumlah client lain pada AP yang sama'],
      evidence_missing: ['Data interferensi/retry/channel utilisation dari radio AP'],
      next_steps: ['Cek jarak/posisi client dan penghalang fisik', 'Cek channel serta interferensi radio AP', 'Uji dari perangkat lain di lokasi sama'],
    },
    client_gone: {
      scenario: 'B',
      title: 'Kemungkinan client meninggalkan jaringan',
      evidence_present: ['Riwayat snapshot client per AP'],
      evidence_missing: ['Alasan dari sisi perangkat client (dimatikan, sleep, roaming ke AP lain)'],
      next_steps: ['Cek apakah perangkat dimatikan atau berpindah AP', 'Cek riwayat flapping client ini'],
    },
  };
  const base = table[kind] ?? table.client_rf;
  return { ...base, confidence, affected_clients: context.mac ? [context.mac] : [], context };
}

// --- §6 Korelasi Skenario A–D ------------------------------------------------
const AVAILABILITY_RULES = ['ap.unreachable', 'ap.ssh.unavailable', 'ap.ssh.auth_failed', 'ap.ssh.config', 'ap.flapping'];
// Gejala jalur internet AP (latency/putus): beberapa AP sekaligus → masalah upstream bersama.
const LATENCY_RULES = ['ap.latency.high', 'ap.latency.critical', 'ap.internet.down'];
// ap.client_count.* diturunkan dari daftar client yang sama dengan indikator `clients`:
// bukan indikator mandiri, jadi tidak dihitung sebagai resource AP (hindari skor ganda).
// Radio/ethernet: kondisi AP sendiri (bukan client) — indikator mandiri untuk korelasi §6.
// Radio padat bisa berasal dari AP tetangga, tetapi tetap alasan "AP ini perlu dilihat".
const RESOURCE_RULES = ['ap.memory.high', 'ap.load.high', 'ap.link.speed_low', 'ap.link.errors', 'ap.radio.ng.busy', 'ap.radio.na.busy', 'ap.radio.ng.interference', 'ap.radio.na.interference'];
const CLIENT_RULES = ['client.signal.weak', 'client.signal.critical', 'client.flapping', 'client.disconnected', 'client.traffic_stalled'];
// Gejala "client bermasalah". client.disconnected TIDAK termasuk: client yang pulang atau
// dimatikan menghasilkan alert yang sama dengan client yang putus karena masalah, jadi churn
// hanya dicatat sebagai alert info — bukan indikator insiden AP (dulu satu AP bisa dapat
// incident.ap hanya karena clientnya berangsur pulang).
const SYMPTOM_CLIENT_RULES = ['client.signal.weak', 'client.signal.critical', 'client.flapping', 'client.traffic_stalled'];

export function isClientAlert(ruleId) {
  return CLIENT_RULES.includes(ruleId);
}

// Baris korelasi/insiden merangkum kondisi AP, bukan gejala AP itu sendiri. Tanpa ini
// skenario B menahan deteksi ulang dirinya sendiri (baris B terbuka = "alert non-client"),
// sehingga korelasi yang masih berlaku ditutup siklus berikutnya lalu dibuka lagi: berkedip.
function isCorrelationAlert(ruleId) {
  return ruleId.startsWith('incident.') || ruleId.startsWith('correlation.');
}

function byDevice(alerts) {
  const map = new Map();
  for (const a of alerts) {
    if (a.device_id === null || a.device_id === undefined) continue;
    if (!map.has(a.device_id)) map.set(a.device_id, []);
    map.get(a.device_id).push(a);
  }
  return map;
}

// alerts: alert terbuka (BUKAN resolved) + temuan baru pada evaluasi ini, supaya korelasi
// tidak tertinggal satu siklus. devices: [{ id, stale, client_count }].
export function correlateAlerts({ atMs, alerts = [], devices = [], collectorAgeMs = null }) {
  const deviceAlerts = byDevice(alerts);
  const staleDevices = devices.filter((d) => d.stale);
  const heartbeatStale = collectorAgeMs !== null && collectorAgeMs > ALERT.collectorStaleMs;
  const out = [];

  // D — collector: heartbeat tua, atau banyak AP kehilangan update bersamaan.
  const collectorSignals = [];
  if (heartbeatStale) collectorSignals.push(`heartbeat collector berumur ${collectorAgeMs} ms (> ${ALERT.collectorStaleMs} ms)`);
  if (staleDevices.length >= ALERT.correlation.collectorStaleDevices) collectorSignals.push(`${staleDevices.length} AP kehilangan update metrik bersamaan`);
  if (collectorSignals.length) {
    out.push(correlationAlert({
      rule_id: 'incident.collector',
      device_id: null,
      title: ALERT_RULES['incident.collector'].title,
      severity: 'critical',
      atMs,
      confidence: heartbeatStale && staleDevices.length >= ALERT.correlation.collectorStaleDevices ? 'high' : 'medium',
      scenario: 'D',
      indicators: [
        { source: 'collector', detail: { heartbeat_age_ms: collectorAgeMs, heartbeat_stale: heartbeatStale, stale_after_ms: ALERT.collectorStaleMs } },
        { source: 'devices', detail: { stale_device_ids: staleDevices.map((d) => d.id), total_devices: devices.length } },
      ],
      evidence_present: collectorSignals,
      evidence_missing: ['Status proses/service collector (systemctl, log)', 'Konektivitas DB dan beban host collector'],
      note: 'Banyak AP "tidak terjangkau" sekaligus biasanya masalah pengumpulan data, bukan AP. Alert per-AP ditahan selama kondisi ini.',
      next_steps: ['Cek service collector (systemctl status ama-collector)', 'Cek log collector dan error terakhir', 'Cek koneksi DB serta beban host collector', 'Verifikasi satu AP manual (ping/ssh) dari host collector'],
      affected_devices: staleDevices.map((d) => d.id),
    }));
  }

  // C — pola bersama: beberapa AP terganggu bersamaan tetapi masih terjangkau.
  const degraded = [...deviceAlerts.entries()].filter(([, list]) =>
    list.some((a) => LATENCY_RULES.includes(a.rule_id) || ['ap.ssh.unavailable', 'ap.ssh.auth_failed'].includes(a.rule_id)));
  const degradedIds = degraded.map(([id]) => id);
  const pingAlive = degradedIds.length >= ALERT.correlation.sharedMinDevices && degraded.every(([, list]) => !list.some((a) => a.rule_id === 'ap.unreachable'));
  if (!heartbeatStale && pingAlive) {
    out.push(correlationAlert({
      rule_id: 'incident.shared_network',
      device_id: null,
      title: ALERT_RULES['incident.shared_network'].title,
      severity: 'warning',
      atMs,
      confidence: degradedIds.length >= 3 ? 'high' : 'medium',
      scenario: 'C',
      indicators: degraded.map(([id, list]) => ({ source: 'device', detail: { device_id: id, rules: list.filter((a) => LATENCY_RULES.includes(a.rule_id) || a.rule_id.startsWith('ap.ssh.')).map((a) => a.rule_id) } })),
      evidence_present: [`${degradedIds.length} AP menunjukkan gejala pada waktu berdekatan`, 'AP masih menjawab ping (bukan offline total)'],
      evidence_missing: ['Pengukuran gateway/DNS/internet dari collector', 'Status port switch/uplink', 'Log UniFi controller'],
      note: 'Dari SSH AP saja tidak dapat dipastikan apakah masalahnya di switch, gateway, DNS, atau internet.',
      next_steps: ['Cek switch/uplink bersama yang dipakai AP-AP tersebut', 'Uji ping/traceroute dari host collector ke gateway dan ke AP', 'Cek log UniFi controller untuk event uplink/switch'],
      affected_devices: degradedIds,
      affected_clients: [...new Set(degraded.flatMap(([, list]) => list.map((a) => a.target).filter(Boolean)))],
    }));
  }

  // A — satu AP dengan beberapa indikator mandiri.
  const apIssueDevices = new Set();
  for (const [id, list] of deviceAlerts) {
    if (staleDevices.some((d) => d.id === id)) continue; // sudah ditangani D
    const device = devices.find((d) => d.id === id) ?? { id };
    const clientList = list.filter((a) => isClientAlert(a.rule_id));
    const signalClients = clientList.filter((a) => a.rule_id.startsWith('client.signal.'));
    const flapClients = clientList.filter((a) => a.rule_id === 'client.flapping');
    const goneClients = clientList.filter((a) => a.rule_id === 'client.disconnected');
    // Hanya gejala RF/nyata yang mengangkat indikator `clients`; client yang hilang tetap
    // dilaporkan sebagai hitungan `disappeared`.
    const symptomClients = [...new Set(clientList.filter((a) => SYMPTOM_CLIENT_RULES.includes(a.rule_id)).map((a) => a.target))];
    const resourceRules = list.filter((a) => RESOURCE_RULES.includes(a.rule_id)).map((a) => a.rule_id);
    const connectivityRules = list.filter((a) => LATENCY_RULES.includes(a.rule_id) || AVAILABILITY_RULES.includes(a.rule_id)).map((a) => a.rule_id);
    // Indikator independen: client terdampak, resource AP, konektivitas AP.
    const indicators = [];
    if (symptomClients.length) {
      indicators.push({ source: 'clients', detail: { affected_clients: symptomClients, weak_signal: signalClients.length, flapping: flapClients.length, disappeared: goneClients.length, client_count: device.client_count ?? null } });
    }
    if (resourceRules.length) indicators.push({ source: 'ap_resources', detail: { rules: resourceRules } });
    if (connectivityRules.length) indicators.push({ source: 'ap_connectivity', detail: { rules: connectivityRules } });
    if (indicators.length < ALERT.correlation.apMinScore) continue;

    apIssueDevices.add(id);
    out.push(correlationAlert({
      rule_id: 'incident.ap',
      device_id: id,
      title: ALERT_RULES['incident.ap'].title,
      severity: 'warning',
      atMs,
      confidence: indicators.length >= 3 ? 'high' : 'medium',
      scenario: 'A',
      indicators,
      evidence_present: [`${indicators.length} indikator mandiri pada AP ini`, `${symptomClients.length} client terdampak`],
      // Link ethernet + channel utilisation kini dinilai sendiri (ap.link.*, ap.radio.*).
      evidence_missing: ['Counter port switch sisi uplink', 'Retry radio per client', 'Log AP'],
      note: 'Indikator saling menguatkan, tetapi penyebab fisik belum terkonfirmasi: ini bukan pernyataan bahwa AP rusak.',
      next_steps: ['Cek uplink/kabel/port switch AP ini', 'Cek channel dan interferensi radio', 'Bandingkan dengan AP lain di lokasi sama'],
      affected_devices: [id],
      affected_clients: symptomClients,
    }));
  }

  // B — client individual: AP sehat, client lain normal.
  for (const [id, list] of deviceAlerts) {
    if (apIssueDevices.has(id) || staleDevices.some((d) => d.id === id)) continue;
    const clientList = list.filter((a) => SYMPTOM_CLIENT_RULES.includes(a.rule_id));
    if (!clientList.length) continue;
    // AP punya masalah sendiri → skenario A yang berlaku, bukan B.
    if (list.some((a) => !isClientAlert(a.rule_id) && !isCorrelationAlert(a.rule_id) && a.rule_id !== 'ap.reboot')) continue;
    const targets = [...new Set(clientList.map((a) => a.target).filter(Boolean))];
    const device = devices.find((d) => d.id === id) ?? { id };
    out.push(correlationAlert({
      rule_id: 'correlation.client_issue',
      device_id: id,
      title: 'Possible client-side or local RF issue',
      severity: 'info',
      atMs,
      confidence: clientList.length >= 2 ? 'medium' : 'low',
      scenario: 'B',
      indicators: clientList.map((a) => ({ source: 'client', detail: { mac: a.target, rule_id: a.rule_id } })),
      evidence_present: [`${targets.length} client bermasalah`, `AP sehat, ${device.client_count ?? 'tidak diketahui'} client terhubung`],
      evidence_missing: ['Posisi fisik client', 'Retry/kualitas RF per client'],
      note: 'Satu client bermasalah sementara AP dan client lain normal → fokus ke sisi client/RF lokal.',
      next_steps: ['Cek posisi dan jarak client ke AP', 'Cek riwayat sinyal client ini', 'Uji dari perangkat lain di lokasi sama'],
      affected_devices: [id],
      affected_clients: targets,
    }));
  }

  return out;
}

function correlationAlert({ rule_id, device_id, title, severity, atMs, confidence, scenario, indicators, evidence_present, evidence_missing, note, next_steps, affected_devices = [], affected_clients = [] }) {
  return {
    rule_id,
    device_id,
    target: null,
    severity,
    // Tanpa ini planAlertChanges() hanya melihat item non-aktif dan insiden tidak
    // pernah dibuat (temuan smoke test DB).
    active: true,
    title,
    since: new Date(atMs).toISOString(),
    evidence: { kind: 'correlation', scenario, confidence, indicators, affected_devices, affected_clients },
    diagnosis: {
      scenario,
      confidence,
      // Aturan eksplisit §6, bukan probabilitas statistik.
      confidence_rule: 'high = ≥3 indikator independen; medium = 2 indikator; low = 1 indikator atau data tidak lengkap.',
      title,
      indicators,
      evidence_present,
      evidence_missing,
      note,
      next_steps,
      affected_devices,
      affected_clients,
    },
  };
}

// desired → op DB. Idempoten: dipanggil dengan state terbaru menghasilkan keputusan sama,
// sehingga restart collector tidak menggandakan alert §4.
export function planAlertChanges(desired, existing, { at, reopenWindowMs = ALERT.cooldownMs, touchIntervalMs = ALERT.touchIntervalMs } = {}) {
  const atMs = ms(at) ?? Date.now();
  const nowIso = new Date(atMs).toISOString();
  const open = new Map();
  const resolved = new Map();
  for (const row of existing ?? []) {
    if (row.status === ALERT_STATUS.resolved) {
      const prev = resolved.get(row.dedup_key);
      if (!prev || (ms(row.resolved_at) ?? 0) > (ms(prev.resolved_at) ?? 0)) resolved.set(row.dedup_key, row);
    } else {
      open.set(row.dedup_key, row);
    }
  }

  const ops = [];
  for (const item of desired) {
    const current = open.get(item.dedup_key);
    if (item.active) {
      if (!current) {
        const previous = resolved.get(item.dedup_key);
        const previousResolvedAt = previous ? ms(previous.resolved_at) : null;
        // Pulih lalu muncul lagi dalam cooldown → baris yang sama dibuka ulang.
        if (previous && previousResolvedAt !== null && atMs - previousResolvedAt <= reopenWindowMs) {
          ops.push({ op: 'reopen', id: previous.id, at: nowIso, first_seen_at: item.since ?? nowIso, last_seen_at: nowIso, dedup_key: item.dedup_key, desired: item });
        } else {
          ops.push({ op: 'create', at: nowIso, first_seen_at: item.since ?? nowIso, last_seen_at: nowIso, dedup_key: item.dedup_key, desired: item });
        }
        continue;
      }
      // Alert yang sudah diakui tetap diperbarui buktinya, tanpa menurunkan status.
      const stale = ms(current.last_seen_at) === null || atMs - ms(current.last_seen_at) >= touchIntervalMs;
      if (stale) ops.push({ op: 'touch', id: current.id, at: nowIso, last_seen_at: nowIso, dedup_key: item.dedup_key, desired: item });
    } else if (current) {
      ops.push({ op: 'resolve', id: current.id, at: nowIso, dedup_key: item.dedup_key, desired: item });
    }
  }
  return ops;
}
