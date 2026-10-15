// Parser murni §4.3 — tanpa I/O, tanpa jaringan. Diuji dengan fixture asli.
import { ERROR_CODE, METRIC_STATUS, ok, invalid, unsupported } from './contracts.js';

const KIB = 1024;

// Konversi field teks jadi angka; hilang/rusak/NaN/Infinity → invalid.
function toNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return invalid(ERROR_CODE.missing);
  }
  const n = Number(String(raw).trim());
  // Number('abc') = NaN → not_numeric; Number('1e999') = Infinity → not_finite.
  if (Number.isNaN(n)) return invalid(ERROR_CODE.not_numeric);
  if (!Number.isFinite(n)) return invalid(ERROR_CODE.not_finite);
  return ok(n);
}

// /proc/uptime: pakai field pertama (detik). Field kedua bukan CPU %.
export function parseUptime(text) {
  if (typeof text !== 'string') return { uptime_seconds: invalid(ERROR_CODE.missing) };
  const first = text.trim().split(/\s+/)[0];
  const parsed = toNumber(first);
  if (parsed.status !== METRIC_STATUS.ok) {
    return { uptime_seconds: parsed };
  }
  if (parsed.value < 0) return { uptime_seconds: invalid(ERROR_CODE.out_of_range) };
  return { uptime_seconds: parsed };
}

// /proc/loadavg: tiga field pertama adalah load 1/5/15 menit; tanpa simbol %.
export function parseLoadavg(text) {
  const empty = {
    load_1: invalid(ERROR_CODE.missing),
    load_5: invalid(ERROR_CODE.missing),
    load_15: invalid(ERROR_CODE.missing),
  };
  if (typeof text !== 'string') return empty;

  const parts = text.trim().split(/\s+/);
  const pick = (idx) => {
    const parsed = toNumber(parts[idx]);
    if (parsed.status !== METRIC_STATUS.ok) return parsed;
    if (parsed.value < 0) return invalid(ERROR_CODE.out_of_range);
    return parsed;
  };

  return { load_1: pick(0), load_5: pick(1), load_15: pick(2) };
}

function meminfoField(text, name) {
  const re = new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*kB\\s*$`, 'm');
  const match = text.match(re);
  return match ? match[1] : undefined;
}

// /proc/meminfo: nilai kB diperlakukan sebagai KiB (×1024).
export function parseMeminfo(text) {
  const result = {
    memory_total_bytes: invalid(ERROR_CODE.missing),
    memory_available_bytes: invalid(ERROR_CODE.missing),
    memory_used_bytes: invalid(ERROR_CODE.missing),
    memory_used_percent: invalid(ERROR_CODE.missing),
  };
  if (typeof text !== 'string') return result;

  const totalKib = toNumber(meminfoField(text, 'MemTotal'));
  const availKib = toNumber(meminfoField(text, 'MemAvailable'));

  // MemTotal <= 0 tidak valid.
  let totalValid = false;
  if (totalKib.status !== METRIC_STATUS.ok) {
    result.memory_total_bytes = totalKib;
  } else if (totalKib.value <= 0) {
    result.memory_total_bytes = invalid(ERROR_CODE.not_positive);
  } else {
    result.memory_total_bytes = ok(totalKib.value * KIB);
    totalValid = true;
  }

  // MemAvailable = 0 valid (estimasi 100%); di luar 0..MemTotal tidak valid.
  let availValid = false;
  if (availKib.status !== METRIC_STATUS.ok) {
    result.memory_available_bytes = availKib;
  } else if (!totalValid) {
    // Tidak bisa menilai rentang tanpa total yang valid.
    result.memory_available_bytes = invalid(ERROR_CODE.dependency);
  } else if (availKib.value < 0 || availKib.value > totalKib.value) {
    result.memory_available_bytes = invalid(ERROR_CODE.out_of_range);
  } else {
    result.memory_available_bytes = ok(availKib.value * KIB);
    availValid = true;
  }

  // Turunan hanya valid bila total dan available sama-sama valid.
  if (totalValid && availValid) {
    const total = totalKib.value * KIB;
    const avail = availKib.value * KIB;
    const used = total - avail;
    result.memory_used_bytes = ok(used);
    result.memory_used_percent = ok((used / total) * 100);
  }

  return result;
}

function statusesToCollectionStatus(statuses) {
  const values = Object.values(statuses);
  const anyOk = values.some((s) => s.status === METRIC_STATUS.ok);
  const allOk = values.every((s) => s.status === METRIC_STATUS.ok);
  if (allOk) return 'ok';
  if (anyOk) return 'partial';
  return 'error';
}

// Gabungkan tiga keluaran jadi satu sampel sistem yang tervalidasi.
// outputs: { uptime, loadavg, meminfo } — string mentah atau undefined bila gagal ambil.
export function normalizeSystemSample({ deviceId, observedAt, outputs = {}, receivedAt }) {
  const uptime = parseUptime(outputs.uptime);
  const load = parseLoadavg(outputs.loadavg);
  const mem = parseMeminfo(outputs.meminfo);

  const metricStatus = {
    uptime_seconds: uptime.uptime_seconds,
    load_1: load.load_1,
    load_5: load.load_5,
    load_15: load.load_15,
    memory_total_bytes: mem.memory_total_bytes,
    memory_available_bytes: mem.memory_available_bytes,
    memory_used_bytes: mem.memory_used_bytes,
    memory_used_percent: mem.memory_used_percent,
  };

  return {
    device_id: deviceId,
    kind: 'system',
    observed_at: observedAt,
    received_at: receivedAt ?? new Date().toISOString(),
    collection_status: statusesToCollectionStatus(metricStatus),
    metric_status: metricStatus,
    uptime_seconds: uptime.uptime_seconds.value,
    load_1: load.load_1.value,
    load_5: load.load_5.value,
    load_15: load.load_15.value,
    memory_total_bytes: mem.memory_total_bytes.value,
    memory_available_bytes: mem.memory_available_bytes.value,
    memory_used_bytes: mem.memory_used_bytes.value,
    memory_used_percent: mem.memory_used_percent.value,
  };
}

export { unsupported };
