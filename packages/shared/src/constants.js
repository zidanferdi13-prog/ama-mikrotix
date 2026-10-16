// Usulan §4.2 konsep-mvp.md. Titik awal uji 3 AP, belum target production.

export const COLLECT_INTERVAL_MS = {
  ping: 15_000,
  system: 60_000,
};

// Collector menyegarkan daftar AP dari DB sesering ini (tambah/nonaktif/hapus
// dari dashboard berlaku tanpa restart).
export const DEVICE_REFRESH_MS = 15_000;

export const CONCURRENCY = {
  ping: 2,
  system: 2,
};

export const TIMEOUT_MS = {
  ping: 2_000,
  sshConnect: 5_000,
  sshCommand: 5_000,
  sshSession: 15_000,
};

// Kesegaran: ping > 45s, metrik sistem > 180s sejak observasi valid terakhir.
export const STALE_MS = {
  ping: 45_000,
  metric: 180_000,
};

// Usulan §5, menunggu persetujuan.
export const TRANSITION = {
  downAfterFailures: 3,
  recoverAfterSuccesses: 2,
};

export const HISTORY = {
  defaultRangeMs: 60 * 60 * 1000,
  maxRangeMs: 24 * 60 * 60 * 1000,
};

// Perintah tetap, bukan dari request pengguna.
export const SYSTEM_COMMANDS = [
  'cat /proc/uptime',
  'cat /proc/loadavg',
  'cat /proc/meminfo',
  // Jumlah client Wi-Fi; UniFi menjawab JSON. Vendor lain → parser unsupported.
  'mca-dump',
];

// --- Alert §5: semua ambang di satu tempat. Nilai awal untuk uji, kalibrasi ulang
// setelah mengamati kondisi normal (lihat docs/devops.md "Alert"). ---------------
const MIN_MS = 60_000;

export const ALERT = {
  evalIntervalMs: 15_000,
  // Umur data maksimum agar rule boleh menilai. Lebih tua → hold: tidak membuka
  // alert baru dan TIDAK menutup alert terbuka ("tidak ada data" ≠ "pulih").
  maxDataAgeMs: { ping: STALE_MS.ping, metric: STALE_MS.metric, client: 3 * MIN_MS },
  windowMs: 30 * MIN_MS, // histori mentah yang dimuat per evaluasi
  // Jendela penilaian per jenis rule (histori yang dipertimbangkan).
  deviceWindowMs: 20 * MIN_MS,
  clientWindowMs: 20 * MIN_MS,
  // Kondisi yang muncul lagi ≤ cooldown setelah pulih → baris lama dibuka ulang
  // (reopen_count naik), bukan alert baru. Lebih lama → alert baru.
  cooldownMs: 30 * MIN_MS,
  // Alert aktif tidak ditulis ulang setiap evaluasi: minimal sejarang ini, supaya
  // updated_at (dan emit realtime) tidak bergetar tiap 15 detik.
  touchIntervalMs: 60_000,
  collectorStaleMs: 90_000, // sama dengan getHealth server
  // Dihapus tiap jam oleh collector. metrics > HISTORY.maxRangeMs; alerts hanya yang
  // resolved (dihitung dari resolved_at) dan > cooldown, jadi reopen tidak terganggu.
  retentionMs: { clients: 24 * 60 * MIN_MS, metrics: 30 * 24 * 60 * MIN_MS, alerts: 90 * 24 * 60 * MIN_MS },
  apFlapping: { windowMs: 15 * MIN_MS, transitions: 3 },
  clientFlapping: { windowMs: 15 * MIN_MS, episodes: 3 },
  // Client dianggap pergi setelah absen pada N snapshot sukses beruntun (bukan 1).
  clientGoneSnapshots: 2,
  // Hilang dari satu AP tapi terlihat di AP lain dalam rentang ini = roaming, bukan
  // client hilang. Satu snapshot per AP ≈ 60 s, jadi 2 menit ≈ 2 snapshot.
  clientElsewhereMs: 2 * MIN_MS,
  // Counter diam + sinyal lemah berulang (indikasi, bukan bukti).
  clientTrafficStalled: { snapshots: 3 },
  // Baseline = median [now-windowMs, now-recentMs); recent = [now-recentMs, now].
  clientCount: { windowMs: 30 * MIN_MS, recentMs: 5 * MIN_MS, dropRatio: 0.5, spikeRatio: 1, minBaseline: 4 },
  reboot: { minDropSeconds: 120, ttlMs: 15 * MIN_MS },
  // no_secret/host_key bersifat deterministik → 1 sampel cukup; timeout/auth → 2 beruntun.
  sshFailures: 2,
  correlation: { apMinScore: 2, sharedMinDevices: 2, collectorStaleDevices: 2 },
};

// kind=threshold dievaluasi generik; sisanya punya evaluator khusus di alerts.js.
// Latency = RTT ICMP collector → AP, BUKAN latency client → gateway/internet.
// signal = dBm dari mca-dump (negatif; makin kecil makin lemah).
const thr = (severity, title, metric, source, direction, threshold, recover, minMin, recoverMin) => ({
  kind: 'threshold', severity, title, metric, source, direction, threshold, recover,
  minDurationMs: minMin * MIN_MS, recoverDurationMs: recoverMin * MIN_MS,
});

export const ALERT_RULES = {
  'ap.unreachable': { kind: 'availability', severity: 'critical', title: 'AP tidak terjangkau (ping)' },
  'ap.flapping': { kind: 'flapping', severity: 'warning', title: 'AP down/recovered berulang' },
  'ap.ssh.unavailable': { kind: 'ssh', severity: 'warning', title: 'SSH AP tidak merespons padahal ping normal' },
  'ap.ssh.auth_failed': { kind: 'ssh', severity: 'warning', title: 'Login SSH AP ditolak' },
  'ap.ssh.config': { kind: 'ssh', severity: 'warning', title: 'Kredensial/host key SSH AP belum siap' },
  'ap.metrics.stale': { kind: 'stale', severity: 'warning', title: 'Metrik sistem AP kedaluwarsa' },
  // Kondisi tidak dapat disimpulkan: bukan offline, bukan pula sehat.
  'ap.collector_stalled': { kind: 'collector', severity: 'info', title: 'Ping AP tidak diperbarui' },
  'ap.unverified': { kind: 'unknown', severity: 'info', title: 'Kondisi AP tidak dapat diverifikasi' },
  'ap.reboot': { kind: 'reboot', severity: 'info', title: 'AP reboot (uptime turun)' },
  'ap.client_count.drop': { kind: 'client_count', severity: 'warning', title: 'Jumlah client AP turun signifikan' },
  'ap.client_count.spike': { kind: 'client_count', severity: 'info', title: 'Jumlah client AP melonjak' },
  'ap.latency.high': thr('warning', 'Latency collector→AP tinggi', 'latency_ms', 'ping', 'above', 100, 80, 3, 2),
  'ap.latency.critical': thr('critical', 'Latency collector→AP sangat tinggi', 'latency_ms', 'ping', 'above', 250, 200, 2, 2),
  'ap.memory.high': thr('warning', 'RAM AP tinggi', 'memory_used_percent', 'system', 'above', 85, 80, 5, 3),
  // ponytail: ambang load absolut; jumlah CPU AP belum dikumpulkan. Ganti ke
  // load/CPU bila /proc/cpuinfo ditambahkan ke SYSTEM_COMMANDS.
  'ap.load.high': thr('warning', 'Load average AP tinggi', 'load_1', 'system', 'above', 4, 2, 5, 3),
  'client.signal.weak': thr('warning', 'Sinyal client lemah', 'signal_dbm', 'client', 'below', -70, -67, 3, 3),
  'client.signal.critical': thr('warning', 'Sinyal client sangat lemah', 'signal_dbm', 'client', 'below', -80, -77, 2, 3),
  'client.flapping': { kind: 'client_flapping', severity: 'warning', title: 'Client sering hilang lalu muncul lagi' },
  'client.disconnected': { kind: 'client_disconnected', severity: 'info', title: 'Client hilang pada beberapa snapshot' },
  'client.traffic_stalled': { kind: 'client_traffic', severity: 'info', title: 'Trafik client tidak bergerak' },
  'correlation.client_issue': { kind: 'correlation', severity: 'info', title: 'Possible client-side or local RF issue' },
  'incident.ap': { kind: 'correlation', severity: 'warning', title: 'Possible AP/radio/uplink issue' },
  'incident.shared_network': { kind: 'correlation', severity: 'warning', title: 'Possible shared network/upstream issue' },
  'incident.collector': { kind: 'correlation', severity: 'critical', title: 'Possible collector/data collection issue' },
};

export const KINDS = {
  ping: 'ping',
  system: 'system',
};
