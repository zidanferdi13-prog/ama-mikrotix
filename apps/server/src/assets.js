// Nama aset + pemilik untuk daftar client live, dari API inventaris ICT
// (`data.master_data[]`, dicocokkan lewat mac_addr). Opsional: tanpa AMA_ASSET_API_URL fitur mati.
// Hanya asset_name + owner yang diteruskan; kolom lain (telepon, harga, dst.) tidak pernah ke frontend.

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

// Format MAC tak terjamin (aa:bb.., AA-BB.., aabb.cc..): bandingkan 12 hex saja.
const normMac = (mac) => String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');

async function loadIndex(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error('asset_api_http'), { code: `http_${res.status}` });
  const rows = (await res.json())?.data?.master_data;
  if (!Array.isArray(rows)) throw Object.assign(new Error('asset_api_shape'), { code: 'bad_shape' });
  const index = new Map();
  for (const row of rows) {
    const key = normMac(row?.mac_addr);
    // MAC ganda di inventaris: baris pertama menang.
    if (key.length === 12 && !index.has(key)) {
      index.set(key, { asset_name: row.asset_name ?? null, owner: row.owner ?? null });
    }
  }
  return index;
}

// Aset untuk MAC apa pun (target alert, client terdampak, observasi) → Map mac → { name, owner }.
// Kunci memakai string MAC apa adanya dari pemanggil, jadi pencarian di frontend cukup kecocokan persis.
export function assetLookupFor(lookup) {
  return async (macs) => {
    const list = [...new Set(macs.filter((mac) => typeof mac === 'string' && mac !== ''))];
    if (!lookup || list.length === 0) return new Map();
    const rows = await lookup(list.map((mac) => ({ mac })));
    return new Map(rows.filter((row) => row.asset_name).map((row) => [row.mac, { name: row.asset_name, owner: row.asset_owner }]));
  };
}

// Mengembalikan fungsi (clients) → clients + { asset_name, asset_owner }, atau null bila mati.
export function createAssetLookup(url = process.env.AMA_ASSET_API_URL, { fetchFn = fetch, ttlMs = TTL_MS } = {}) {
  if (!url) return null;
  let index = null;
  let loadedAt = 0;
  let inflight = null;

  async function current() {
    if (index && Date.now() - loadedAt < ttlMs) return index;
    inflight ??= loadIndex(url, fetchFn)
      .then((fresh) => {
        index = fresh;
        loadedAt = Date.now();
        return fresh;
      })
      .catch((err) => {
        if (index) return index;
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return async (clients) => {
    const idx = await current();
    return clients.map((c) => {
      const hit = idx.get(normMac(c.mac));
      return { ...c, asset_name: hit?.asset_name ?? null, asset_owner: hit?.owner ?? null };
    });
  };
}
