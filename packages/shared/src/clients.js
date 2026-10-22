// Pemetaan murni keluaran `mca-dump` (UniFi) → daftar client. Dipakai server (daftar live)
// dan collector (snapshot untuk alert). Tanpa I/O.
export const MAX_CLIENTS = 200;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// Kode kegagalan SSH yang stabil. Host key paling spesifik; auth ≠ timeout ≠ connect.
export function sshCodeFor(err, hostKeyReason) {
  if (hostKeyReason) return hostKeyReason;
  if (err?.code === 'parse_failed') return 'parse_failed';
  if (err?.code === 'timeout') return 'timeout';
  if (err?.level === 'client-timeout') return 'timeout';
  if (err?.level === 'client-authentication') return 'auth_failed';
  return 'connect_failed';
}

// sta_table tidak memuat ssid; label VAP (`vap_table[].name`) dipakai sebagai ssid.
export function toClient(sta, vap) {
  return {
    hostname: text(sta.hostname) ?? text(sta.name),
    ip: text(sta.ip),
    mac: text(sta.mac),
    radio: text(vap.radio),
    ssid: text(vap.name),
    signal: num(sta.signal),
    rssi: num(sta.rssi),
    uptime_s: num(sta.uptime),
    tx_bytes: num(sta.tx_bytes),
    rx_bytes: num(sta.rx_bytes),
    tx_rate: num(sta.tx_rate),
    rx_rate: num(sta.rx_rate),
    satisfaction: num(sta.satisfaction),
    // Untuk diagnosa: SNR (signal − noise) dan rasio retry.
    noise: num(sta.noise),
    tx_retries: num(sta.tx_retries),
    tx_packets: num(sta.tx_packets),
  };
}

// Bentuk tak dikenal → { ok:false }, bukan daftar kosong.
export function mapClients(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  const vaps = data?.vap_table;
  if (!Array.isArray(vaps)) return { ok: false };

  const all = [];
  for (const vap of vaps) {
    if (!Array.isArray(vap?.sta_table)) continue;
    for (const sta of vap.sta_table) {
      if (sta && typeof sta === 'object') all.push(toClient(sta, vap));
    }
  }
  return { ok: true, clients: all.slice(0, MAX_CLIENTS), total: all.length, truncated: all.length > MAX_CLIENTS };
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

// Snapshot untuk client_observations: identitas = MAC (lowercase) + AP.
// Hostname/IP sengaja tidak disimpan (privasi; lihat docs/devops.md).
export function clientSnapshot(stdout) {
  const mapped = mapClients(stdout);
  if (!mapped.ok) return { ok: false, clients: [] };
  const seen = new Set();
  const clients = [];
  for (const c of mapped.clients) {
    const mac = c.mac?.toLowerCase();
    if (!mac || !MAC_RE.test(mac) || seen.has(mac)) continue;
    seen.add(mac);
    clients.push({
      mac,
      signal_dbm: c.signal,
      rssi: c.rssi,
      rx_bytes: c.rx_bytes,
      tx_bytes: c.tx_bytes,
      uptime_s: c.uptime_s,
      radio: c.radio,
      vap: c.ssid,
    });
  }
  return { ok: true, clients };
}
