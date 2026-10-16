import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import Chart from './Chart.jsx';
import { CollectionBadge, FreshnessBadge, ReachabilityBadge } from './Badge.jsx';
import { formatTime, formatUptime, num } from './format.js';

const RANGES = [
  { key: '1h', label: '1 jam', ms: 3_600_000 },
  { key: '6h', label: '6 jam', ms: 6 * 3_600_000 },
  { key: '24h', label: '24 jam', ms: 24 * 3_600_000 },
];

// Ambang kesegaran ping di sisi klien (selaras dengan STALE_MS.ping di packages/shared).
const PING_STALE_MS = 45_000;

export default function Detail({ id, onBack }) {
  const [device, setDevice] = useState(null);
  const [series, setSeries] = useState([]);
  const [range, setRange] = useState(RANGES[0]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - range.ms);
    Promise.all([api.device(id), api.metrics(id, { from: from.toISOString(), to: to.toISOString() })])
      .then(([deviceRes, metricsRes]) => {
        if (cancelled) return;
        setDevice(deviceRes);
        setSeries(metricsRes.metrics ?? []);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || err.status === 401) return;
        setError(err.status === 404 ? 'Perangkat tidak ditemukan.' : 'Gagal memuat detail perangkat.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, range]);

  const backButton = (
    <button type="button" className="btn btn-secondary" onClick={onBack}>
      ← Kembali
    </button>
  );

  if (loading) {
    return (
      <div className="page">
        <div className="page-head">{backButton}</div>
        <p className="center">Memuat detail…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-head">{backButton}</div>
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!device) return null;

  const systemRows = series.filter((row) => row.kind === 'system');
  const pingRows = series.filter((row) => row.kind === 'ping');
  const latestSystem = systemRows.at(-1);
  const latestPing = pingRows.at(-1);

  const systemPoints = (field) =>
    systemRows.map((row) => ({ x: new Date(row.observed_at).getTime(), y: row[field] ?? null }));
  const latencyPoints = pingRows.map((row) => ({
    x: new Date(row.observed_at).getTime(),
    y: row.latency_ms ?? null,
  }));

  const pingFresh = latestPing ? pingFreshness(latestPing.observed_at) : (device.last_ping?.freshness ?? 'no_data');
  const systemAttempt = latestSystem?.observed_at ?? null;
  const observasi = (field, fallback) => validAt(systemRows, field) ?? fallback ?? null;

  const collectionErrors = Object.entries(latestSystem?.metric_status ?? {}).filter(
    ([, value]) => value?.status && value.status !== 'ok',
  );

  return (
    <div className="page">
      <div className="page-head">
        {backButton}
        <div className="toolbar" role="group" aria-label="Rentang waktu grafik">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`btn btn-sm${option.key === range.key ? ' btn-primary' : ''}`}
              aria-pressed={option.key === range.key}
              onClick={() => setRange(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <section className="card">
        <div className="ap-card-head">
          <h2>{device.name}</h2>
          <span className="row-actions">
            <ReachabilityBadge device={device} />
            <CollectionBadge device={device} />
          </span>
        </div>
        <dl className="identity">
          <div>
            <dt>IP / port</dt>
            <dd className="mono">
              {device.ip ?? '—'}
              {device.port ? `:${device.port}` : ''}
            </dd>
          </div>
          <div>
            <dt>Pengguna SSH</dt>
            <dd>{device.username || '—'}</dd>
          </div>
          <div>
            <dt>Vendor / model</dt>
            <dd>
              {device.vendor || '—'}
              {device.model ? ` / ${device.model}` : ''}
            </dd>
          </div>
          <div>
            <dt>Firmware</dt>
            <dd>{device.firmware || '—'}</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd className="mono">{device.host_key_fingerprint || '—'}</dd>
          </div>
          <div>
            <dt>Identitas terverifikasi</dt>
            <dd>{device.identity_verified ? 'Ya' : 'Belum'}</dd>
          </div>
          <div>
            <dt>Status aktif</dt>
            <dd>
              {device.enabled === undefined || device.enabled === null ? '—' : device.enabled ? 'Aktif' : 'Nonaktif'}
            </dd>
          </div>
          <div>
            <dt>Catatan</dt>
            <dd>{device.notes || '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="metric-grid" aria-label="Metrik terakhir">
        <MetricCard
          label="Latency"
          value={
            latestPing?.latency_ms === null || latestPing?.latency_ms === undefined
              ? '—'
              : `${num(latestPing.latency_ms, 1)} ms`
          }
          freshness={pingFresh}
          hint={latestPing ? formatTime(latestPing.observed_at) : 'Belum ada sampel ping'}
        />
        <MetricCard
          label="Uptime"
          value={formatUptime(latestSystem?.uptime_seconds)}
          freshness={device.freshness?.uptime}
        />
        <MetricCard
          label="RAM terpakai"
          value={latestSystem?.memory_used_percent == null ? '—' : `${num(latestSystem.memory_used_percent, 1)} %`}
          freshness={device.freshness?.ram}
        />
        <MetricCard
          label="Load 1/5/15"
          value={
            latestSystem?.load_1 == null
              ? '—'
              : `${num(latestSystem.load_1, 2)} / ${num(latestSystem.load_5, 2)} / ${num(latestSystem.load_15, 2)}`
          }
          freshness={device.freshness?.load}
        />
      </section>

      <section className="card stack">
        <h3>Grafik {range.label} terakhir</h3>
        <Chart values={latencyPoints} label="Latency" unit="ms" height={200} />
        <Chart values={systemPoints('memory_used_percent')} label="RAM terpakai" unit="%" height={200} />
        <Chart values={systemPoints('load_1')} label="Load average 1 menit" height={200} digits={2} />
      </section>

      <section className="card">
        <h3>Kesegaran per metrik</h3>
        <div className="table-wrap">
          <table className="table small">
            <caption className="sr-only">
              Percobaan terakhir, observasi valid terakhir, dan kesegaran tiap metrik
            </caption>
            <thead>
              <tr>
                <th scope="col">Metrik</th>
                <th scope="col">Percobaan terakhir</th>
                <th scope="col">Observasi valid terakhir</th>
                <th scope="col">Kesegaran</th>
              </tr>
            </thead>
            <tbody>
              <FreshnessRow
                label="Ping"
                attempt={device.last_ping_attempt_at ?? latestPing?.observed_at}
                valid={latestPing?.observed_at}
                fresh={pingFresh}
              />
              <FreshnessRow
                label="Uptime"
                attempt={systemAttempt}
                valid={observasi('uptime_seconds', device.last_valid_at?.uptime)}
                fresh={device.freshness?.uptime}
              />
              <FreshnessRow
                label="Load"
                attempt={systemAttempt}
                valid={observasi('load_1', device.last_valid_at?.load)}
                fresh={device.freshness?.load}
              />
              <FreshnessRow
                label="RAM"
                attempt={systemAttempt}
                valid={observasi('memory_used_percent', device.last_valid_at?.ram)}
                fresh={device.freshness?.ram}
              />
              <FreshnessRow
                label="Sistem"
                attempt={systemAttempt}
                valid={device.last_valid_at?.system}
                fresh={device.freshness?.system}
              />
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>Error koleksi terakhir</h3>
        {device.collection_status && device.collection_status !== 'ok' ? (
          <div className="stack">
            <p className="sub">Status koleksi: {device.collection_status}</p>
            {collectionErrors.length === 0 ? (
              <p>—</p>
            ) : (
              <ul className="errors">
                {collectionErrors.map(([metric, value]) => (
                  <li key={metric}>
                    {metric}: {value.status} ({value.code ?? '-'})
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p>—</p>
        )}
      </section>

      <section className="card">
        <h3>Event perangkat</h3>
        {!device.events || device.events.length === 0 ? (
          <p>Belum ada event.</p>
        ) : (
          <ul className="events">
            {device.events.map((event) => (
              <li key={event.id}>
                <span className="event-head">
                  <span className="event-name">{event.detail?.transition ?? event.type}</span>
                  <span className="sub">{event.status}</span>
                </span>
                <p className="sub">{formatTime(event.started_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MetricCard({ label, value, freshness, hint }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <FreshnessBadge freshness={freshness} />
      {hint && <span className="sub">{hint}</span>}
    </div>
  );
}

function FreshnessRow({ label, attempt, valid, fresh }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{attempt ? formatTime(attempt) : '—'}</td>
      <td>{valid ? formatTime(valid) : '—'}</td>
      <td>{fresh ? <FreshnessBadge freshness={fresh} /> : '—'}</td>
    </tr>
  );
}

// Observasi valid terakhir di rentang terpilih; null bila tidak ada sampel valid.
function validAt(rows, field) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i][field] !== null && rows[i][field] !== undefined) return rows[i].observed_at;
  }
  return null;
}

function pingFreshness(observedAt) {
  if (!observedAt) return 'no_data';
  const age = Date.now() - new Date(observedAt).getTime();
  if (Number.isNaN(age)) return 'no_data';
  return age > PING_STALE_MS ? 'stale' : 'fresh';
}
