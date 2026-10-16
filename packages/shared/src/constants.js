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

export const KINDS = {
  ping: 'ping',
  system: 'system',
};
