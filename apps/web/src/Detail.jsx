import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import Chart from './Chart.jsx';
import { StatusBadge } from './Summary.jsx';
import {
  REACHABLE_LABEL,
  FRESHNESS_LABEL,
  reachabilityOf,
  collectionLabel,
  formatTime,
  num,
} from './format.js';

const RANGES = [
  { label: '1 jam', ms: 60 * 60 * 1000 },
  { label: '24 jam', ms: 24 * 60 * 60 * 1000 },
];

export default function Detail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [series, setSeries] = useState([]);
  const [rangeMs, setRangeMs] = useState(RANGES[0].ms);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - rangeMs);
    Promise.all([
      api.device(id),
      api.metrics(id, { from: from.toISOString(), to: to.toISOString() }),
    ])
      .then(([device, metrics]) => {
        if (cancelled) return;
        setData(device);
        setSeries(metrics.metrics);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.status === 404 ? 'Perangkat tidak ditemukan.' : 'Gagal memuat detail.');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, rangeMs]);

  if (loading) return <p className="center">Memuat detail…</p>;
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return null;

  const latestSystem = series.filter((m) => m.kind === 'system').at(-1);
  const latestPing = series.filter((m) => m.kind === 'ping').at(-1);
  const reach = reachabilityOf(data);

  // x = epoch ms; y null saat metrik tidak valid → jadi gap.
  const mk = (field) =>
    series
      .filter((m) => m.kind === 'system')
      .map((m) => ({ x: new Date(m.observed_at).getTime(), y: m[field] === null ? null : Number(m[field]) }));
  const latency = series
    .filter((m) => m.kind === 'ping')
    .map((m) => ({ x: new Date(m.observed_at).getTime(), y: m.latency_ms === null ? null : Number(m.latency_ms) }));

  return (
    <main className="content">
      <button type="button" onClick={onBack} className="back">
        ← Kembali
      </button>

      <section className="card">
        <h2>{data.name}</h2>
        <dl className="identity">
          <div>
            <dt>IP</dt>
            <dd>{data.ip}</dd>
          </div>
          <div>
            <dt>Vendor / model</dt>
            <dd>{data.vendor || '—'} {data.model ? `/ ${data.model}` : ''}</dd>
          </div>
          <div>
            <dt>Firmware</dt>
            <dd>{data.firmware || '—'}</dd>
          </div>
          <div>
            <dt>Identitas terverifikasi</dt>
            <dd>{data.identity_verified ? 'Ya' : 'Belum'}</dd>
          </div>
        </dl>
      </section>

      <section className="cards">
        <Card label="Keterjangkauan" value={<StatusBadge tone={reach} label={REACHABLE_LABEL[reach]} />} />
        <Card label="Koleksi sistem" value={collectionLabel(data)} />
        <Card label="Latency" value={latestPing?.latency_ms != null ? `${num(latestPing.latency_ms, 1)} ms` : '—'} />
        <Card
          label="Uptime"
          value={latestSystem?.uptime_seconds != null ? formatUptime(latestSystem.uptime_seconds) : '—'}
        />
        <Card
          label="RAM terpakai"
          value={latestSystem?.memory_used_percent != null ? `${num(latestSystem.memory_used_percent, 1)}%` : '—'}
        />
        <Card
          label="Load 1/5/15"
          value={
            latestSystem?.load_1 != null
              ? `${num(latestSystem.load_1, 2)} / ${num(latestSystem.load_5, 2)} / ${num(latestSystem.load_15, 2)}`
              : '—'
          }
        />
      </section>

      <section className="card">
        <h3>Waktu</h3>
        <table className="table small">
          <thead>
            <tr>
              <th scope="col">Metrik</th>
              <th scope="col">Percobaan terakhir</th>
              <th scope="col">Observasi valid terakhir</th>
              <th scope="col">Kesegaran</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Ping" attempt={data.last_ping_attempt_at} valid={latestPing?.observed_at} fresh={pingFreshness(latestPing)} />
            <Row label="Uptime" valid={data.last_valid_at?.uptime} fresh={data.freshness?.uptime} />
            <Row label="Load" valid={data.last_valid_at?.load} fresh={data.freshness?.load} />
            <Row label="RAM" valid={data.last_valid_at?.ram} fresh={data.freshness?.ram} />
          </tbody>
        </table>
      </section>

      <section className="toolbar">
        <label>
          Rentang
          <select value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.ms} value={r.ms}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <Chart series={latency} label="Latency" unit="ms" />
        <Chart series={mk('memory_used_percent')} label="RAM terpakai" unit="%" />
        <Chart series={mk('load_1')} label="Load average 1 menit" unit="tanpa persen" />
      </section>

      <section className="card">
        <h3>Error koleksi terakhir</h3>
        {latestSystem?.collection_status && latestSystem.collection_status !== 'ok' ? (
          <ul className="errors">
            {Object.entries(latestSystem.metric_status ?? {})
              .filter(([, v]) => v?.status && v.status !== 'ok')
              .map(([k, v]) => (
                <li key={k}>
                  {k}: {v.status} ({v.code ?? '-'})
                </li>
              ))}
          </ul>
        ) : (
          <p>—</p>
        )}
      </section>

      <section className="card">
        <h3>Event perangkat</h3>
        {data.events.length === 0 ? (
          <p>Belum ada event.</p>
        ) : (
          <ul className="events">
            {data.events.map((e) => (
              <li key={e.id}>
                <span>{formatTime(e.started_at)}</span>
                <span>{e.detail?.transition ?? e.type}</span>
                <span>{e.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Card({ label, value }) {
  return (
    <div className="card stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Row({ label, attempt, valid, fresh }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{attempt ? formatTime(attempt) : '—'}</td>
      <td>{formatTime(valid)}</td>
      <td>{FRESHNESS_LABEL[fresh] ?? '—'}</td>
    </tr>
  );
}

function formatUptime(seconds) {
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}h ${h}j ${m}m`;
}

// Kesegaran ping dihitung dari sampel ping, bukan dari metrik sistem.
function pingFreshness(latestPing) {
  if (!latestPing?.observed_at) return 'no_data';
  const age = Date.now() - new Date(latestPing.observed_at).getTime();
  return age > 45_000 ? 'stale' : 'fresh';
}
