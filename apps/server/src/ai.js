// Ringkasan AI untuk hasil diagnosa. Opsional: tanpa AMA_AI_API_KEY fitur mati dan dashboard
// tetap menampilkan diagnosa rule-based. Satu format: OpenAI-compatible /chat/completions
// (OpenAI, Gemini `.../v1beta/openai`, Anthropic `.../v1`, OpenRouter) lewat fetch bawaan.
// Data yang keluar ke cloud: temuan + angka metrik saja. MAC, IP client, nama aset, dan
// pemilik TIDAK dikirim (diganti label generik).

const TIMEOUT_MS = 25_000;

export function aiConfig(env = process.env) {
  if (!env.AMA_AI_API_KEY) return null;
  return {
    baseUrl: (env.AMA_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.AMA_AI_API_KEY,
    model: env.AMA_AI_MODEL || 'gpt-4o-mini',
  };
}

const MAC_RE = /\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/gi;
const IP_RE = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

// Hapus identitas client dari teks temuan. IP gateway/8.8.8.8 bukan data pribadi: dibiarkan.
export function redact(text, { names = [], keepIps = [] } = {}) {
  let out = String(text ?? '').replace(MAC_RE, '[mac]');
  out = out.replace(IP_RE, (ip) => (keepIps.includes(ip) ? ip : '[ip]'));
  for (const name of names) if (name && name.length >= 3) out = out.split(name).join('[client]');
  return out;
}

export function buildPayload({ device, result, live, target }) {
  const names = [target?.hostname, target?.asset_name, target?.asset_owner].filter(Boolean);
  const keepIps = [live?.gatewayIp, '8.8.8.8'].filter(Boolean);
  const r = (t) => (t == null ? null : redact(t, { names, keepIps }));
  const s = live?.sample ?? {};
  return {
    ap: { name: device.name, model: device.model ?? null },
    keluhan: target ? 'Satu user mengeluh sinyal jelek / tidak bisa internet' : 'Cek kesehatan AP umum',
    verdict: result.verdict,
    temuan: result.findings.map((f) => ({ level: f.level, area: f.area, judul: r(f.title), detail: r(f.detail), saran: r(f.action) })),
    metrik_ap: {
      uptime_s: s.uptime_seconds ?? null,
      ram_percent: s.memory_used_percent ?? null,
      load_1: s.load_1 ?? null,
      client_count: s.client_count ?? null,
      eth_speed_mbps: s.eth_speed_mbps ?? null,
      radio_24_beban_percent: s.radio_ng_cu_total ?? null,
      radio_5_beban_percent: s.radio_na_cu_total ?? null,
      internet_latency_ms: s.internet_latency_ms ?? null,
    },
    client: target
      ? { band: target.radio, signal_dbm: target.signal, noise_dbm: target.noise, satisfaction: target.satisfaction, tx_rate_kbps: target.tx_rate, punya_ip: Boolean(target.ip) }
      : null,
  };
}

const SYSTEM_PROMPT = [
  'Kamu asisten helpdesk jaringan Wi-Fi kantor (AP UniFi). Jawab dalam Bahasa Indonesia, singkat dan praktis.',
  'Gunakan HANYA data JSON yang diberikan; jangan mengarang angka atau penyebab yang tidak didukung data.',
  'Format: 1) Kesimpulan (1-2 kalimat: kemungkinan penyebab keluhan). 2) Bukti (maks 3 poin, sebut angka).',
  '3) Langkah untuk teknisi (maks 4 poin, urut paling mungkin dulu). 4) Jawaban untuk user (1 kalimat ramah, non-teknis).',
  'Bila semua temuan ok, katakan jaringan terlihat sehat dan sarankan cek perangkat user (restart Wi-Fi, lupakan jaringan, dekati AP).',
  'Teks biasa tanpa markdown tebal/tabel.',
].join(' ');

// → { ok:true, text, model } | { ok:false, code }
export async function summarize(payload, { config = aiConfig(), fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!config) return { ok: false, code: 'ai_disabled' };
  try {
    const res = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'empty_reply' };
    return { ok: true, text: text.trim(), model: config.model };
  } catch (err) {
    return { ok: false, code: err?.name === 'TimeoutError' ? 'timeout' : 'request_failed' };
  }
}
