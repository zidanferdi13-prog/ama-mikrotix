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

// `mca-dump` (UniFi): JSON dengan vap_table[].num_sta. Jumlah client = Σ num_sta.
// JSON valid tanpa vap_table → unsupported (vendor lain), bukan nol.
export function parseClientCount(text) {
  if (typeof text !== 'string' || text.trim() === '') return { client_count: invalid(ERROR_CODE.missing) };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { client_count: invalid(ERROR_CODE.not_numeric) };
  }
  if (!Array.isArray(data?.vap_table)) return { client_count: unsupported() };
  let total = 0;
  for (const vap of data.vap_table) {
    const n = vap?.num_sta;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { client_count: invalid(ERROR_CODE.not_numeric) };
    }
    total += n;
  }
  return { client_count: ok(total) };
}

// Identitas AP dari JSON mca-dump yang sama (tanpa perintah SSH tambahan). `info` tidak
// tersedia lewat exec non-interaktif (ash: info: not found). Vendor hanya disimpulkan bila
// JSON berbentuk UniFi (vap_table ada); model/firmware wajib string non-kosong, selain itu null.
export function parseDeviceIdentity(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.vap_table)) return null;
  const str = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  const model = str(data.model_display, 120) ?? str(data.model, 120);
  const firmware = str(data.version, 80);
  if (!model || !firmware) return null;
  return { vendor: 'Ubiquiti', model, firmware };
}

// Kolom link ethernet (if_table[0]) + radio per band (radio_table[].athstats) dari mca-dump.
export const LINK_COLUMNS = ['eth_speed_mbps', 'eth_full_duplex', 'eth_up', 'eth_rx_errors', 'eth_tx_errors', 'eth_rx_dropped', 'eth_tx_dropped'];
export const RADIO_BANDS = ['ng', 'na'];
const RADIO_FIELDS = ['channel', 'cu_total', 'cu_interf', 'noise_floor', 'tx_retries', 'tx_packets'];
export const RADIO_COLUMNS = RADIO_BANDS.flatMap((band) => RADIO_FIELDS.map((f) => `radio_${band}_${f}`));

// Nilai di luar rentang/bukan angka → null (bukan 0). Counter kumulatif: bulat ≥ 0.
const intIn = (v, lo, hi) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null);
const counter = (v) => intIn(v, 0, Number.MAX_SAFE_INTEGER);
const flag = (v) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null);

// JSON tanpa if_table/radio_table → unsupported (vendor lain), seperti client_count.
export function parseLinkRadio(text) {
  const values = Object.fromEntries([...LINK_COLUMNS, ...RADIO_COLUMNS].map((c) => [c, null]));
  if (typeof text !== 'string' || text.trim() === '') return { values, link: invalid(ERROR_CODE.missing), radio: invalid(ERROR_CODE.missing) };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { values, link: invalid(ERROR_CODE.not_numeric), radio: invalid(ERROR_CODE.not_numeric) };
  }

  let link = unsupported();
  if (Array.isArray(data?.if_table)) {
    const eth = data.if_table[0] ?? {};
    // speed 0 = link tidak aktif: bukan kecepatan, simpan null (bukan 0).
    values.eth_speed_mbps = intIn(eth.speed, 1, 65535);
    values.eth_full_duplex = flag(eth.full_duplex);
    values.eth_up = flag(eth.up);
    for (const k of ['rx_errors', 'tx_errors', 'rx_dropped', 'tx_dropped']) values[`eth_${k}`] = counter(eth[k]);
    link = values.eth_speed_mbps === null ? invalid(ERROR_CODE.not_numeric) : ok(values.eth_speed_mbps);
  }

  let radio = unsupported();
  if (Array.isArray(data?.radio_table)) {
    for (const band of RADIO_BANDS) {
      const a = data.radio_table.find((r) => r?.radio === band)?.athstats ?? {};
      // Channel ada di VAP, bukan radio_table; vwire* = VAP mesh internal.
      const vap = (Array.isArray(data.vap_table) ? data.vap_table : []).find((v) => v?.radio === band && !String(v?.essid ?? '').startsWith('vwire'));
      values[`radio_${band}_channel`] = intIn(vap?.channel, 1, 233);
      values[`radio_${band}_cu_total`] = intIn(a.cu_total, 0, 100);
      values[`radio_${band}_cu_interf`] = intIn(a.cu_interf, 0, 100);
      // ponytail: noise floor 2.4 GHz firmware ini berisi sampah (mis. -2078592224); rentang
      // fisik -120..-50 dBm saja yang disimpan. Perluas bila ada radio dengan rentang lain.
      values[`radio_${band}_noise_floor`] = intIn(a.noise_floor, -120, -50);
      values[`radio_${band}_tx_retries`] = counter(a.n_tx_retries);
      values[`radio_${band}_tx_packets`] = counter(a.n_tx_pkts);
    }
    const anyCu = RADIO_BANDS.some((b) => values[`radio_${b}_cu_total`] !== null);
    radio = anyCu ? ok(null) : invalid(ERROR_CODE.not_numeric);
  }
  return { values, link, radio };
}

function statusesToCollectionStatus(statuses) {
  const values = Object.values(statuses);
  const anyOk = values.some((s) => s.status === METRIC_STATUS.ok);
  const allOk = values.every((s) => s.status === METRIC_STATUS.ok);
  if (allOk) return 'ok';
  if (anyOk) return 'partial';
  return 'error';
}

// Ping AP → internet (perintah dijalankan DI AP lewat SSH, stdout+stderr digabung).
// BusyBox: "3 packets transmitted, 3 packets received, 0% packet loss" +
// "round-trip min/avg/max = 16.7/17.5/18.1 ms"; iputils: "rtt min/avg/max/mdev = …".
// Kode: dns_failed (bad address / unknown host), no_reply (100% loss), missing (perintah
// gagal/timeout → tidak diketahui, BUKAN bukti internet mati).
export const INTERNET_COLUMNS = ['internet_latency_ms', 'internet_loss_percent'];

export function parseInternetPing(text) {
  const values = { internet_latency_ms: null, internet_loss_percent: null };
  if (typeof text !== 'string' || text.trim() === '') return { values, internet: invalid(ERROR_CODE.missing) };
  if (/bad address|unknown host|name or service not known|could not resolve|temporary failure in name resolution/i.test(text)) {
    return { values, internet: invalid('dns_failed') };
  }
  const stats = text.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received/i);
  if (!stats) {
    return { values, internet: /not found|applet not found/i.test(text) ? unsupported() : invalid(ERROR_CODE.missing) };
  }
  const sent = Number(stats[1]);
  const received = Number(stats[2]);
  if (!(sent > 0) || received < 0 || received > sent) return { values, internet: invalid(ERROR_CODE.out_of_range) };
  values.internet_loss_percent = Math.round(((sent - received) / sent) * 100);
  if (received === 0) return { values, internet: invalid(ERROR_CODE.no_reply) };
  const rtt = text.match(/(?:round-trip|rtt)[^=]*=\s*[\d.]+\/([\d.]+)\//i);
  const avg = rtt ? Number(rtt[1]) : NaN;
  if (!Number.isFinite(avg) || avg < 0) return { values, internet: invalid(ERROR_CODE.not_numeric) };
  values.internet_latency_ms = avg;
  return { values, internet: ok(avg) };
}

// Gabungkan keluaran perintah jadi satu sampel sistem yang tervalidasi.
// outputs: { uptime, loadavg, meminfo, mcaDump, internet } — string mentah atau undefined bila gagal ambil.
export function normalizeSystemSample({ deviceId, observedAt, outputs = {}, receivedAt }) {
  const uptime = parseUptime(outputs.uptime);
  const load = parseLoadavg(outputs.loadavg);
  const mem = parseMeminfo(outputs.meminfo);
  const clients = parseClientCount(outputs.mcaDump);
  const linkRadio = parseLinkRadio(outputs.mcaDump);
  const internet = parseInternetPing(outputs.internet);

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
    // client_count/link/radio/internet tidak ikut menentukan collection_status: AP non-UniFi
    // tidak punya mca-dump, dan internet putus bukan kegagalan koleksi metrik AP.
    collection_status: statusesToCollectionStatus(metricStatus),
    metric_status: { ...metricStatus, client_count: clients.client_count, link: linkRadio.link, radio: linkRadio.radio, internet: internet.internet },
    uptime_seconds: uptime.uptime_seconds.value,
    load_1: load.load_1.value,
    load_5: load.load_5.value,
    load_15: load.load_15.value,
    memory_total_bytes: mem.memory_total_bytes.value,
    memory_available_bytes: mem.memory_available_bytes.value,
    memory_used_bytes: mem.memory_used_bytes.value,
    memory_used_percent: mem.memory_used_percent.value,
    client_count: clients.client_count.value,
    ...linkRadio.values,
    ...internet.values,
  };
}

export { unsupported };
