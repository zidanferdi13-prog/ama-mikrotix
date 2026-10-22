// Diagnosa rule-based kesehatan AP dan satu client (keluhan "sinyal jelek / tidak bisa
// internet"). Murni: tanpa I/O. Masukan dari cek live SSH (apps/server/src/ssh-diagnose.js).
// AI (opsional) hanya merangkum temuan ini; keputusan tetap dari aturan di sini.

// Ambang diagnosa. Sinyal/latency mengikuti ALERT_RULES agar dashboard dan diagnosa sepakat.
export const DIAG = {
  signalWeak: -70,
  signalBad: -80,
  snrLow: 20, // dB
  satisfactionWarn: 80,
  satisfactionBad: 50,
  txRateLowKbps: 24_000,
  retryRatioWarn: 0.3,
  gatewayLatencyWarnMs: 20,
  internetLatencyWarnMs: 100,
  internetLatencyBadMs: 250,
  radioBusyPercent: 70,
  radioInterfPercent: 30,
  memoryWarnPercent: 85,
  loadWarn: 4,
  recentRebootS: 600,
};

const LEVEL_RANK = { bad: 3, warn: 2, unknown: 1, ok: 0 };
const BAND = { ng: '2,4 GHz', na: '5 GHz' };

function worst(findings) {
  return findings.reduce((acc, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[acc] ? f.level : acc), 'ok');
}

const fmt = (n, d = 1) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

// ping: hasil parseInternetPing { values:{internet_latency_ms, internet_loss_percent}, internet:{status, code} }
function pingOf(res) {
  if (!res) return { ok: false, code: 'missing', latency: null, loss: null };
  return { ok: res.internet?.status === 'ok', code: res.internet?.code ?? null, latency: res.values?.internet_latency_ms ?? null, loss: res.values?.internet_loss_percent ?? null };
}

// Jalur internet berlapis: AP → gateway → 8.8.8.8 (IP) → google.com (DNS).
function pathFindings({ gatewayIp, gateway, publicIp, internet }) {
  const out = [];
  const gw = pingOf(gateway);
  const ip = pingOf(publicIp);
  const net = pingOf(internet);

  if (!gatewayIp) {
    out.push({ area: 'uplink', level: 'bad', title: 'AP tidak punya default gateway', detail: 'Tabel route AP tanpa rute default.', action: 'Cek konfigurasi IP/DHCP AP di controller.' });
  } else if (!gw.ok) {
    out.push({ area: 'uplink', level: 'bad', title: `Gateway ${gatewayIp} tidak membalas dari AP`, detail: `Loss ${fmt(gw.loss, 0)} %.`, action: 'Cek kabel/port switch uplink AP dan VLAN ke gateway.' });
  } else {
    const slow = gw.latency > DIAG.gatewayLatencyWarnMs || gw.loss > 0;
    out.push({ area: 'uplink', level: slow ? 'warn' : 'ok', title: `Gateway ${gatewayIp}: ${fmt(gw.latency)} ms, loss ${fmt(gw.loss, 0)} %`, detail: slow ? 'LAN lokal seharusnya < 20 ms tanpa loss.' : 'Jalur AP ke gateway sehat.', action: slow ? 'Cek beban/port switch dan kualitas kabel uplink.' : null });
  }

  if (!ip.ok && gw.ok) {
    out.push({ area: 'internet', level: 'bad', title: 'AP tidak bisa ke internet (8.8.8.8 tidak membalas)', detail: 'Gateway membalas, tetapi jalur keluar ke internet putus.', action: 'Cek link ISP / router utama / firewall ICMP keluar.' });
  }

  if (net.code === 'dns_failed') {
    out.push({ area: 'internet', level: 'bad', title: 'DNS gagal: google.com tidak bisa di-resolve', detail: ip.ok ? 'Internet via IP jalan, hanya DNS yang bermasalah.' : 'DNS dan jalur internet sama-sama gagal.', action: 'Cek DNS server yang dipakai jaringan (resolv.conf AP / DHCP).' });
  } else if (net.ok) {
    const level = net.latency > DIAG.internetLatencyBadMs ? 'bad' : net.latency > DIAG.internetLatencyWarnMs || net.loss > 0 ? 'warn' : 'ok';
    out.push({ area: 'internet', level, title: `Internet (google.com): ${fmt(net.latency)} ms, loss ${fmt(net.loss, 0)} %`, detail: level === 'ok' ? 'AP bisa akses internet dengan normal.' : 'Latency/loss ke internet di atas normal.', action: level === 'ok' ? null : 'Cek pemakaian bandwidth uplink / ISP.' });
  } else if (gw.ok && ip.ok) {
    out.push({ area: 'internet', level: 'warn', title: 'Ping google.com tidak terbaca', detail: `Kode: ${net.code ?? 'tidak diketahui'}.`, action: null });
  }
  return out;
}

function apFindings(sample) {
  const out = [];
  if (!sample) return out;
  if (sample.eth_up === 0) out.push({ area: 'ap', level: 'bad', title: 'Link ethernet AP down', detail: null, action: 'Cek kabel uplink.' });
  else if (sample.eth_speed_mbps != null && sample.eth_speed_mbps < 1000) {
    out.push({ area: 'ap', level: 'warn', title: `Link ethernet ${sample.eth_speed_mbps} Mbps (bukan gigabit)`, detail: 'Throughput Wi-Fi tertahan oleh uplink.', action: 'Cek kabel/konektor dan port switch.' });
  }
  for (const band of ['ng', 'na']) {
    const cu = sample[`radio_${band}_cu_total`];
    const intf = sample[`radio_${band}_cu_interf`];
    const ch = sample[`radio_${band}_channel`];
    if (cu != null && cu > DIAG.radioBusyPercent) {
      out.push({ area: 'radio', level: 'warn', title: `Radio ${BAND[band]} sangat sibuk (${cu} %, ch ${ch ?? '—'})`, detail: 'Waktu udara hampir habis: semua client di band ini ikut lambat.', action: 'Pindah kanal, kurangi client, atau tambah AP.' });
    }
    if (intf != null && intf > DIAG.radioInterfPercent) {
      out.push({ area: 'radio', level: 'warn', title: `Interferensi ${BAND[band]} tinggi (${intf} %)`, detail: 'Sumber di luar AP ini memakai kanal yang sama.', action: 'Pindai kanal dan pindah ke kanal yang lebih bersih.' });
    }
  }
  if (sample.memory_used_percent != null && sample.memory_used_percent > DIAG.memoryWarnPercent) {
    out.push({ area: 'ap', level: 'warn', title: `RAM AP ${fmt(sample.memory_used_percent)} %`, detail: null, action: 'Pantau; reboot di luar jam kerja bila terus tinggi.' });
  }
  if (sample.load_1 != null && sample.load_1 > DIAG.loadWarn) {
    out.push({ area: 'ap', level: 'warn', title: `Load AP ${fmt(sample.load_1, 2)}`, detail: null, action: 'Pantau beban AP.' });
  }
  if (sample.uptime_seconds != null && sample.uptime_seconds < DIAG.recentRebootS) {
    out.push({ area: 'ap', level: 'warn', title: `AP baru menyala ${Math.round(sample.uptime_seconds / 60)} menit`, detail: 'Client sempat putus saat AP restart.', action: 'Cek daya/PoE bila restart tidak disengaja.' });
  }
  return out;
}

const snrOf = (c) => (c.signal != null && c.noise != null ? c.signal - c.noise : null);
const retryOf = (c) => (c.tx_retries != null && c.tx_packets > 0 ? c.tx_retries / c.tx_packets : null);

function clientsFindings(clients) {
  if (!clients?.length) return [];
  const weak = clients.filter((c) => c.signal != null && c.signal < DIAG.signalWeak);
  const unhappy = clients.filter((c) => c.satisfaction != null && c.satisfaction >= 0 && c.satisfaction < DIAG.satisfactionWarn);
  const level = weak.length / clients.length >= 0.5 && weak.length >= 2 ? 'warn' : 'ok';
  return [{
    area: 'radio',
    level,
    title: `${clients.length} client · ${weak.length} sinyal lemah · ${unhappy.length} kepuasan rendah`,
    detail: level === 'ok' ? 'Mayoritas client di AP ini sehat.' : 'Separuh lebih client bersinyal lemah: area cakupan AP kurang.',
    action: level === 'ok' ? null : 'Evaluasi posisi/daya pancar AP atau tambah AP di area itu.',
  }];
}

function clientFindings(c, sample) {
  const out = [];
  // Identitas client tidak masuk teks temuan (sudah tampil di header hasil; aman untuk AI).
  if (c.signal != null) {
    const level = c.signal < DIAG.signalBad ? 'bad' : c.signal < DIAG.signalWeak ? 'warn' : 'ok';
    const snr = snrOf(c);
    out.push({
      area: 'client',
      level,
      title: `Sinyal client: ${c.signal} dBm${snr === null ? '' : ` (SNR ${snr} dB)`} di ${BAND[c.radio] ?? c.radio ?? '—'}`,
      detail: level === 'ok' ? 'Sinyal cukup kuat.' : 'Perangkat terlalu jauh/terhalang dari AP.',
      action: level === 'ok' ? null : 'Minta user mendekat ke AP, atau cek apakah ada AP lebih dekat yang seharusnya dipakai.',
    });
    if (level === 'ok' && snr !== null && snr < DIAG.snrLow) {
      out.push({ area: 'client', level: 'warn', title: `SNR rendah (${snr} dB)`, detail: 'Noise tinggi walau sinyal cukup.', action: 'Cek interferensi di sekitar user.' });
    }
  }
  if (!c.ip) out.push({ area: 'client', level: 'bad', title: 'Client terhubung Wi-Fi tetapi belum punya IP', detail: 'DHCP tidak memberi alamat: tanpa IP tidak ada internet.', action: 'Cek DHCP server/pool penuh/VLAN SSID.' });
  if (c.satisfaction != null && c.satisfaction >= 0 && c.satisfaction < DIAG.satisfactionWarn) {
    out.push({ area: 'client', level: c.satisfaction < DIAG.satisfactionBad ? 'bad' : 'warn', title: `Kepuasan koneksi (UniFi) ${c.satisfaction} %`, detail: 'Skor gabungan sinyal, retry, dan latency Wi-Fi.', action: null });
  }
  if (c.tx_rate != null && c.tx_rate < DIAG.txRateLowKbps) {
    out.push({ area: 'client', level: 'warn', title: `Kecepatan link Wi-Fi rendah (${fmt(c.tx_rate / 1000)} Mbps)`, detail: 'Biasanya akibat sinyal lemah atau perangkat lama.', action: null });
  }
  const retry = retryOf(c);
  if (retry !== null && retry > DIAG.retryRatioWarn) {
    out.push({ area: 'client', level: 'warn', title: `Retry kirim tinggi (${Math.round(retry * 100)} %)`, detail: 'Banyak paket harus dikirim ulang: udara padat atau sinyal tidak stabil.', action: null });
  }
  if (c.radio === 'ng' && sample?.radio_na_cu_total != null && c.signal != null && c.signal >= DIAG.signalWeak) {
    out.push({ area: 'client', level: 'ok', title: 'Client di 2,4 GHz', detail: 'Band 5 GHz biasanya lebih cepat dan lebih sepi.', action: 'Bila perangkat mendukung, sarankan pakai 5 GHz.' });
  }
  return out;
}

const HEADLINE = {
  ok: 'Tidak ditemukan masalah di AP maupun jalur internet.',
  warn: 'Ada indikasi gangguan; lihat temuan peringatan.',
  bad: 'Ditemukan masalah yang menjelaskan keluhan.',
  unknown: 'Kondisi tidak dapat diverifikasi.',
};

// live: { ok, code, gatewayIp, gateway, publicIp, internet, sample, clients }
// target: client yang dikeluhkan (opsional; dari mapClients + aset).
export function diagnose({ live, target = null, targetQuery = null }) {
  const findings = [];
  if (!live?.ok) {
    findings.push({ area: 'ap', level: 'unknown', title: 'Tidak bisa masuk SSH ke AP', detail: `Kode: ${live?.code ?? 'unknown'}.`, action: 'Cek AP menyala, kredensial, dan jalur ke AP.' });
  } else {
    if (targetQuery && !target) {
      findings.push({ area: 'client', level: 'warn', title: `"${targetQuery}" tidak terhubung ke AP ini`, detail: null, action: null });
    }
    if (target) findings.push(...clientFindings(target, live.sample));
    findings.push(...pathFindings(live));
    findings.push(...apFindings(live.sample));
    if (!target) findings.push(...clientsFindings(live.clients));
  }
  // Urut: paling parah dulu, area client di depan pada tingkat yang sama.
  findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (a.area === 'client' ? -1 : 0) - (b.area === 'client' ? -1 : 0));
  const verdict = worst(findings);
  return { verdict, headline: HEADLINE[verdict], findings };
}

// Cocokkan keluhan ke client: MAC (format bebas), IP persis, atau potongan nama/aset/pemilik.
export function matchClient(clients, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const hex = q.replace(/[^0-9a-f]/g, '');
  return clients.filter((c) => {
    if (hex.length === 12 && String(c.mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '') === hex) return true;
    if (c.ip && c.ip === q) return true;
    return [c.hostname, c.asset_name, c.asset_owner].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
  });
}
