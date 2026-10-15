// Unix timestamp disimpan UTC, ditampilkan WIB dengan label zona.
const WIB = 'Asia/Jakarta';

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${new Intl.DateTimeFormat('id-ID', {
    timeZone: WIB,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(d)} WIB`;
}

export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const age = nowMs - new Date(iso).getTime();
  if (age < 60_000) return `${Math.max(0, Math.round(age / 1000))}s lalu`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m lalu`;
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}j lalu`;
  return `${Math.round(age / 86_400_000)}h lalu`;
}

// Nilai tidak tersedia → em dash, bukan 0.
export function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

export function bytes(value) {
  if (value === null || value === undefined) return '—';
  const mb = Number(value) / (1024 * 1024);
  return `${mb.toFixed(1)} MiB`;
}

export const REACHABLE_LABEL = {
  up: 'Terjangkau',
  down: 'Tidak terjangkau',
  unknown: 'Belum diketahui',
};

export const FRESHNESS_LABEL = {
  fresh: 'Segar',
  stale: 'Data lama',
  no_data: 'Belum ada data',
};

export function reachabilityOf(device) {
  if (device.reachable === 'up') return 'up';
  if (device.reachable === 'down') return 'down';
  return 'unknown';
}

// Status koleksi sistem, terpisah dari keterjangkauan.
export function collectionLabel(device) {
  if (!device.collection_status) return 'Belum diuji';
  if (device.collection_status === 'ok') return 'Normal';
  if (device.collection_status === 'partial') return 'Sebagian gagal';
  return 'Gagal';
}
