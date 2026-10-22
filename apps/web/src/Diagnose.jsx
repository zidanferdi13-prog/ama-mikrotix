// Diagnosa keluhan "sinyal jelek / tidak bisa internet". Dua pintu masuk:
// - halaman Diagnosa: cari user (nama/IP/MAC/aset/pemilik) di semua AP
// - tombol "Diagnosa AP" di halaman detail AP (DiagnoseCard)
// Hasil rule-based selalu tampil; ringkasan AI tampil bila server mengaktifkannya.
import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { StatusBadge } from './Badge.jsx';
import { formatTime } from './format.js';

const LEVEL = {
  bad: { tone: 'down', label: 'Masalah' },
  warn: { tone: 'stale', label: 'Peringatan' },
  unknown: { tone: 'unknown', label: 'Tidak diketahui' },
  ok: { tone: 'ok', label: 'OK' },
};
const BAND = { ng: '2,4 GHz', na: '5 GHz' };

const ERRORS = {
  no_secret: 'AP ini belum punya password tersimpan. Isi lewat halaman Perangkat.',
  in_progress: 'Diagnosa yang sama sedang berjalan. Tunggu sebentar.',
  not_found: 'Perangkat tidak ditemukan.',
};
const errorText = (err) => ERRORS[err.code] ?? (err.fields?.query ? 'Isi nama, IP, atau MAC user.' : 'Diagnosa gagal dijalankan.');

const AI_CODES = {
  ai_disabled: null,
  timeout: 'Ringkasan AI tidak sempat dibuat (timeout).',
  http_401: 'Ringkasan AI gagal: API key ditolak.',
  http_429: 'Ringkasan AI gagal: kuota/rate limit penyedia AI.',
};

export function useDiagnose() {
  const [state, setState] = useState({ busy: false, error: null, data: null });
  const run = (payload) => {
    setState({ busy: true, error: null, data: null });
    return api
      .diagnose(payload)
      .then((data) => setState({ busy: false, error: null, data }))
      .catch((err) => {
        if (err.status !== 401) setState({ busy: false, error: errorText(err), data: null });
      });
  };
  return { ...state, run };
}

export function DiagnoseResult({ data, onPick }) {
  if (!data) return null;
  if (data.status === 'not_found' || data.status === 'choose') {
    return (
      <div className="stack">
        {data.status === 'not_found' ? (
          <div className="banner banner-warn">"{data.query}" tidak ditemukan di AP mana pun yang bisa dicek. Pastikan perangkat user sedang terhubung Wi-Fi.</div>
        ) : (
          <p className="sub">Ditemukan {data.candidates.length} perangkat. Pilih yang dikeluhkan:</p>
        )}
        {data.candidates.length > 0 && (
          <div className="table-wrap">
            <table className="table small">
              <caption className="sr-only">Kandidat perangkat user</caption>
              <thead>
                <tr>
                  <th scope="col">Nama</th>
                  <th scope="col">Aset / pemilik</th>
                  <th scope="col">IP</th>
                  <th scope="col">AP</th>
                  <th scope="col">Sinyal</th>
                  <th scope="col"><span className="sr-only">Aksi</span></th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={`${c.device_id}-${c.mac}`}>
                    <th scope="row">{c.hostname ?? '—'}</th>
                    <td>{[c.asset_name, c.asset_owner].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="mono">{c.ip ?? '—'}</td>
                    <td>{c.device_name}</td>
                    <td className="num">{c.signal == null ? '—' : `${c.signal} dBm`}</td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => onPick?.({ device_id: c.device_id, query: c.mac })}>
                        Diagnosa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.failed_devices?.length > 0 && (
          <p className="sub">Tidak bisa dicek: {data.failed_devices.map((d) => `${d.name} (${d.code})`).join(', ')}</p>
        )}
      </div>
    );
  }

  const verdict = LEVEL[data.verdict] ?? LEVEL.unknown;
  const t = data.target;
  const aiNote = data.ai && !data.ai.ok ? (AI_CODES[data.ai.code] === undefined ? `Ringkasan AI gagal (${data.ai.code}).` : AI_CODES[data.ai.code]) : null;
  return (
    <div className="stack" aria-live="polite">
      <div className="ap-card-head">
        <span>
          <strong>{data.device.name}</strong>
          {t && (
            <span className="sub">
              {' '}· {t.hostname ?? t.mac}
              {t.asset_owner ? ` (${t.asset_owner})` : ''} · {BAND[t.radio] ?? t.radio ?? '—'}
            </span>
          )}
        </span>
        <StatusBadge tone={verdict.tone} label={verdict.label} />
      </div>
      <p>{data.headline}</p>
      <p className="sub">Dicek live {formatTime(data.observed_at)}</p>

      {data.ai?.ok && (
        <div className="banner banner-info">
          <strong>Ringkasan AI</strong> <span className="sub">({data.ai.model})</span>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: '0.4rem' }}>{data.ai.text}</div>
        </div>
      )}
      {aiNote && <p className="sub">{aiNote}</p>}

      <div className="table-wrap">
        <table className="table small">
          <caption className="sr-only">Temuan diagnosa</caption>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Temuan</th>
              <th scope="col">Saran</th>
            </tr>
          </thead>
          <tbody>
            {data.findings.map((f, i) => (
              <tr key={i}>
                <td>
                  <StatusBadge tone={LEVEL[f.level]?.tone ?? 'unknown'} label={LEVEL[f.level]?.label ?? f.level} />
                </td>
                <td>
                  {f.title}
                  {f.detail && <span className="sub"> — {f.detail}</span>}
                </td>
                <td>{f.action ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tombol di halaman detail AP.
export function DiagnoseCard({ device }) {
  const { busy, error, data, run } = useDiagnose();
  return (
    <section className="card stack" aria-labelledby="diagnose-title">
      <div className="section-head">
        <h3 id="diagnose-title">Diagnosa AP</h3>
        <button type="button" className="btn btn-sm" onClick={() => run({ device_id: device.id })} disabled={busy} aria-busy={busy}>
          {busy ? 'Mendiagnosa…' : data ? 'Diagnosa ulang' : 'Diagnosa AP'}
        </button>
      </div>
      <p className="sub">Masuk SSH ke AP: ping gateway, 8.8.8.8, google.com, baca radio & client. Sekitar 5–10 detik.</p>
      {error && <div className="banner banner-error">Gagal: {error}</div>}
      <DiagnoseResult data={data} onPick={run} />
    </section>
  );
}

// Halaman Diagnosa: dari keluhan user.
export default function Diagnose({ devices }) {
  const [query, setQuery] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [aiEnabled, setAiEnabled] = useState(null);
  const { busy, error, data, run } = useDiagnose();

  useEffect(() => {
    api.diagnoseConfig().then((c) => setAiEnabled(c.ai_enabled)).catch(() => setAiEnabled(false));
  }, []);

  const submit = (event) => {
    event.preventDefault();
    run({ query, ...(deviceId ? { device_id: Number(deviceId) } : {}) });
  };

  return (
    <div className="page">
      <section className="card stack">
        <h2>Diagnosa keluhan user</h2>
        <p className="sub">
          Untuk keluhan "sinyal jelek" atau "tidak bisa internet". Cari perangkat user, lalu sistem mengecek sinyal
          client, AP, gateway, dan internet secara live.
          {aiEnabled === false && ' Ringkasan AI belum aktif (AMA_AI_API_KEY kosong); hasil rule-based tetap tampil.'}
        </p>
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="diag-query">Nama perangkat / IP / MAC / nama aset / pemilik</label>
            <input id="diag-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="mis. LAPTOP-BUDI, 192.168.5.77, Budi" maxLength={64} required disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="diag-device">AP (opsional)</label>
            <select id="diag-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={busy}>
              <option value="">Cari di semua AP</option>
              {devices.filter((d) => d.enabled).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div className="row-actions">
            <button type="submit" className="btn" disabled={busy || !query.trim()} aria-busy={busy}>
              {busy ? 'Mendiagnosa…' : 'Diagnosa'}
            </button>
          </div>
        </form>
        {error && <div className="banner banner-error">Gagal: {error}</div>}
        <DiagnoseResult data={data} onPick={run} />
      </section>
    </div>
  );
}
