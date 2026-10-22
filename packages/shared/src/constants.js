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
  // 4 perintah baca + ping internet (≤ INTERNET_PROBE.deadlineS) dalam satu sesi.
  sshSession: 20_000,
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

// Uji internet DARI AP (lewat sesi SSH yang sama): AP → google.com. Ini yang dipakai
// sebagai "latency"; ping collector → AP hanya bukti AP terjangkau dari server.
// -w = batas total detik (DNS lambat/paket hilang tidak menahan sesi SSH).
export const INTERNET_PROBE = { host: 'google.com', count: 3, deadlineS: 4 };

// Perintah tetap, bukan dari request pengguna.
export const SYSTEM_COMMANDS = [
  'cat /proc/uptime',
  'cat /proc/loadavg',
  'cat /proc/meminfo',
  // Jumlah client Wi-Fi; UniFi menjawab JSON. Vendor lain → parser unsupported.
  'mca-dump',
  // BusyBox ping; stderr digabung agar "bad address" (DNS gagal) terbaca.
  `ping -c ${INTERNET_PROBE.count} -w ${INTERNET_PROBE.deadlineS} ${INTERNET_PROBE.host} 2>&1`,
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
  // Counter diam + sinyal lemah berulang (indikasi, bukan bukti). Kalibrasi 2026-10-16:
  // 3 snapshot → 104/127 alert pulih < 10 menit (HP idle sesaat); 5 ≈ 5 menit diam.
  clientTrafficStalled: { snapshots: 5 },
  // Baseline = median [now-windowMs, now-recentMs); recent = [now-recentMs, now].
  // Kalibrasi 2026-10-16 (replay histori hari itu, 9 AP, 0–18 client): minBaseline 4 → 16
  // episode drop, kebanyakan churn kecil (mis. 5→3); 6 → 10 episode. Dengan 6, penurunan
  // minimum yang memicu = 3 client (rasio 0,5).
  clientCount: { windowMs: 30 * MIN_MS, recentMs: 5 * MIN_MS, dropRatio: 0.5, spikeRatio: 1, minBaseline: 6 },
  reboot: { minDropSeconds: 120, ttlMs: 15 * MIN_MS },
  // no_secret/host_key bersifat deterministik → 1 sampel cukup; timeout/auth → 2 beruntun.
  sshFailures: 2,
  correlation: { apMinScore: 2, sharedMinDevices: 2, collectorStaleDevices: 2 },
  // Counter rx/tx_errors uplink naik pada ≥ minIncreases interval sampel dalam deviceWindowMs
  // (20 menit) → aktif; kenaikan di jendela < minIncreases → pulih.
  // Kalibrasi 2026-10-16: error 0 di 9 AP. rx_dropped TIDAK dinilai (lihat devops.md).
  linkErrors: { minIncreases: 2 },
  // Ping AP → internet gagal (DNS gagal / 100% loss) pada N sampel sistem beruntun → alert.
  // Satu sampel ≈ 60 s, jadi 2 ≈ 1–2 menit. Pulih: satu sampel sukses.
  internetFailures: 2,
};

// kind=threshold dievaluasi generik; sisanya punya evaluator khusus di alerts.js.
// Latency = RTT ICMP AP → google.com (dijalankan di AP lewat SSH), bukan collector → AP.
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
  'ap.internet.down': { kind: 'internet', severity: 'critical', title: 'AP tidak bisa akses internet (ping google.com gagal)' },
  'ap.latency.high': thr('warning', 'Latency AP→internet tinggi', 'internet_latency_ms', 'system', 'above', 100, 80, 3, 2),
  'ap.latency.critical': thr('critical', 'Latency AP→internet sangat tinggi', 'internet_latency_ms', 'system', 'above', 250, 200, 2, 2),
  'ap.memory.high': thr('warning', 'RAM AP tinggi', 'memory_used_percent', 'system', 'above', 85, 80, 5, 3),
  // ponytail: ambang load absolut; jumlah CPU AP belum dikumpulkan. Ganti ke
  // load/CPU bila /proc/cpuinfo ditambahkan ke SYSTEM_COMMANDS.
  'ap.load.high': thr('warning', 'Load average AP tinggi', 'load_1', 'system', 'above', 4, 2, 5, 3),
  // ponytail: ambang 1000 karena semua model AP saat ini (UAP-AC-LR/Lite/Pro) punya port
  // gigabit. Bila ada AP 100 Mbps-only, butuh ambang per model/AP.
  'ap.link.speed_low': thr('warning', 'Link ethernet AP di bawah 1 Gbps', 'eth_speed_mbps', 'system', 'below', 1000, 1000, 5, 5),
  'ap.link.errors': { kind: 'link_errors', severity: 'warning', title: 'Error ethernet uplink AP bertambah' },
  // Channel utilisation = % waktu udara terpakai (semua sumber). Kalibrasi 2026-10-16: maks 39.
  'ap.radio.ng.busy': thr('warning', 'Radio 2,4 GHz AP sangat sibuk', 'radio_ng_cu_total', 'system', 'above', 70, 60, 10, 5),
  'ap.radio.na.busy': thr('warning', 'Radio 5 GHz AP sangat sibuk', 'radio_na_cu_total', 'system', 'above', 70, 60, 10, 5),
  'ap.radio.ng.interference': thr('info', 'Interferensi radio 2,4 GHz tinggi', 'radio_ng_cu_interf', 'system', 'above', 30, 20, 10, 5),
  'ap.radio.na.interference': thr('info', 'Interferensi radio 5 GHz tinggi', 'radio_na_cu_interf', 'system', 'above', 30, 20, 10, 5),
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
