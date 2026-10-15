import React, { useMemo, useState } from 'react';
import {
  REACHABLE_LABEL,
  FRESHNESS_LABEL,
  reachabilityOf,
  collectionLabel,
  formatRelative,
  formatTime,
  num,
} from './format.js';

export default function Summary({ devices, alerts, loading, onSelect }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  const counts = useMemo(() => {
    const base = { total: devices.length, up: 0, down: 0, unknown: 0 };
    for (const d of devices) base[reachabilityOf(d)] += 1;
    return base;
  }, [devices]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (q && !`${d.name} ${d.ip}`.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'stale') return Object.values(d.freshness ?? {}).some((f) => f === 'stale');
      return reachabilityOf(d) === filter;
    });
  }, [devices, query, filter]);

  if (loading) return <p className="center">Memuat data…</p>;

  return (
    <main className="content">
      <section className="cards" aria-label="Ringkasan status">
        <Card label="Total AP" value={counts.total} />
        <Card label="Terjangkau" value={counts.up} tone="ok" />
        <Card label="Tidak terjangkau" value={counts.down} tone="down" />
        <Card label="Belum diketahui" value={counts.unknown} tone="unknown" />
      </section>

      <section className="toolbar">
        <label>
          Cari nama/IP
          <input value={query} onChange={(e) => setQuery(e.target.value)} type="search" />
        </label>
        <label>
          Filter
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Semua</option>
            <option value="up">Terjangkau</option>
            <option value="down">Tidak terjangkau</option>
            <option value="unknown">Belum diketahui</option>
            <option value="stale">Data lama</option>
          </select>
        </label>
      </section>

      {devices.length === 0 ? (
        <p className="banner">Belum ada perangkat terdaftar.</p>
      ) : (
        <table className="table">
          <caption className="sr-only">Daftar AP dengan status keterjangkauan dan metrik terakhir</caption>
          <thead>
            <tr>
              <th scope="col">Nama</th>
              <th scope="col">IP</th>
              <th scope="col">Keterjangkauan</th>
              <th scope="col">Koleksi sistem</th>
              <th scope="col">Latency</th>
              <th scope="col">RAM</th>
              <th scope="col">Data terakhir</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((d) => {
              const reach = reachabilityOf(d);
              const ram = d.metrics?.memory_used_percent;
              const ramFresh = d.freshness?.ram;
              return (
                <tr key={d.id} onClick={() => onSelect(d.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(d.id)}>
                  <th scope="row">{d.name}</th>
                  <td>{d.ip}</td>
                  <td>
                    <StatusBadge tone={reach} label={REACHABLE_LABEL[reach]} />
                    {ramFresh === 'stale' && reach === 'up' && d.collection_status !== 'ok' && (
                      <span className="sub"> pengambilan metrik gagal</span>
                    )}
                  </td>
                  <td>{collectionLabel(d)}</td>
                  <td>{d.last_ping ? `${num(d.last_ping.latency_ms, 1)} ms` : '—'}</td>
                  <td>
                    {num(ram?.value, 1)}%
                    <span className="sub"> {FRESHNESS_LABEL[ramFresh] ?? ''}</span>
                  </td>
                  <td>{formatRelative(d.last_ping?.observed_at ?? d.metrics?.memory_used_percent?.last_valid_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <section aria-label="Event terbaru">
        <h2>Event terbaru</h2>
        {alerts.length === 0 ? (
          <p className="banner">Belum ada event.</p>
        ) : (
          <ul className="events">
            {alerts.map((a) => (
              <li key={a.id}>
                <span>{formatTime(a.started_at)}</span>
                <span>{a.device_name}</span>
                <span>{a.detail?.transition ?? a.type}</span>
                <span>{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Card({ label, value, tone }) {
  return (
    <div className={`card stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function StatusBadge({ tone, label }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
