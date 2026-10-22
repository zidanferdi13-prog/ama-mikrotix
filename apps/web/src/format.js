// Pemformat tampilan. Unix timestamp disimpan UTC, ditampilkan WIB dengan label zona.
import { ALERT_RULES } from '@ama/shared/constants';
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

// Jam:menit WIB untuk label sumbu-X grafik.
export function formatClock(ms) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: WIB, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const age = nowMs - new Date(iso).getTime();
  if (Number.isNaN(age)) return '—';
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

export function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}h ${h}j ${m}m`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
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
  if (device?.reachable === 'up') return 'up';
  if (device?.reachable === 'down') return 'down';
  return 'unknown';
}

export const COLLECTION_LABEL = {
  ok: 'Normal',
  partial: 'Sebagian gagal',
  error: 'Gagal',
};
// Ringkasan kesegaran terburuk sebuah AP: dipakai untuk filter & badge kartu.
export function worstFreshness(device) {
  const values = Object.values(device?.freshness ?? {});
  if (values.includes('stale')) return 'stale';
  if (values.includes('fresh')) return 'fresh';
  return 'no_data';
}

// Status koleksi sistem, terpisah dari keterjangkauan.
export function collectionLabel(device) {
  if (!device?.collection_status) return 'Belum diuji';
  return COLLECTION_LABEL[device.collection_status] ?? device.collection_status;
}

export function isStale(device) {
  return worstFreshness(device) === 'stale';
}

// Warna sinyal client memakai ambang yang sama dengan rule alert (satu sumber angka).
const SIGNAL_WEAK = ALERT_RULES['client.signal.weak'].threshold;
const SIGNAL_CRITICAL = ALERT_RULES['client.signal.critical'].threshold;

export const SIGNAL_LABEL = { good: 'bagus', weak: 'lemah', bad: 'sangat lemah' };

// dBm: makin negatif makin lemah. null/kosong → tanpa warna.
export function signalTone(dbm) {
  if (dbm === null || dbm === undefined || dbm === '') return null;
  const v = Number(dbm);
  if (!Number.isFinite(v)) return null;
  if (v < SIGNAL_CRITICAL) return 'bad';
  if (v < SIGNAL_WEAK) return 'weak';
  return 'good';
}
// Latency AP → internet (ping google.com dari AP lewat SSH). Gagal terukur → alasan singkat.
export function internetText(latencyMs, code) {
  if (latencyMs !== null && latencyMs !== undefined) return `${num(latencyMs, 1)} ms`;
  if (code === 'dns_failed') return 'DNS gagal';
  if (code === 'no_reply') return 'Tidak ada internet';
  return '—';
}
