import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Chart from './Chart.jsx';
import { FreshnessBadge, ReachabilityBadge } from './Badge.jsx';
import {
  FRESHNESS_LABEL,
  formatRelative,
  formatTime,
  formatUptime,
  isStale,
  num,
  reachabilityOf,
  worstFreshness,
} from './format.js';

const SPARK_RANGE = '24h';

// Baris angka/nol → titik {x, y}; null tetap null supaya gap tidak diinterpolasi.
const toPoints = (values) => (Array.isArray(values) ? values.map((y, x) => ({ x, y })) : []);

export default function Summary({ devices, alerts, loading, refreshKey, onSelect, onManage }) {
  const [query, setQuery] = useState('');
  const [reachFilter, setReachFilter] = useState('all');
  const [freshFilter, setFreshFilter] = useState('all');
  const [summary, setSummary] = useState(null);
  const [summaryFailed, setSummaryFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .summary(SPARK_RANGE)
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setSummaryFailed(false);
      })
      .catch((err) => {
        if (!cancelled && err.status !== 401) setSummaryFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const counts = useMemo(() => {
    const base = { total: devices.length, up: 0, down: 0, unknown: 0, stale: 0 };
    for (const device of devices) {
      base[reachabilityOf(device)] += 1;
      if (isStale(device)) base.stale += 1;
    }
    return base;
  }, [devices]);

  const seriesByDevice = useMemo(() => {
    const map = new Map();
    for (const row of summary?.devices ?? []) map.set(row.id, row.series ?? {});
    return map;
  }, [summary]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((device) => {
      if (q && !`${device.name} ${device.ip}`.toLowerCase().includes(q)) return false;
      if (reachFilter !== 'all' && reachabilityOf(device) !== reachFilter) return false;
      if (freshFilter !== 'all' && worstFreshness(device) !== freshFilter) return false;
      return true;
    });
  }, [devices, query, reachFilter, freshFilter]);

  const filtered = reachFilter !== 'all' || freshFilter !== 'all';

  if (loading) {
    return (
      <div className="page">
        <div className="kpi-strip" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton skeleton-lg" />
          ))}
        </div>
        <p className="center">Memuat data…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Ringkasan</h2>
          <p className="sub">Status seluruh AP terdaftar dan event terbaru.</p>
        </div>
      </div>
      <div className="layout-aside">
        <div className="stack">
          <section className="kpi-strip" aria-label="Ringkasan status">
            <Kpi
              label="Total AP"
              value={counts.total}
              pressed={reachFilter === 'all' && freshFilter === 'all'}
              onClick={() => {
                setReachFilter('all');
                setFreshFilter('all');
              }}
            />
            <Kpi
              label="Terjangkau"
              value={counts.up}
              tone="ok"
              pressed={reachFilter === 'up'}
              onClick={() => setReachFilter(reachFilter === 'up' ? 'all' : 'up')}
            />
            <Kpi
              label="Tidak terjangkau"
              value={counts.down}
              tone="down"
              pressed={reachFilter === 'down'}
              onClick={() => setReachFilter(reachFilter === 'down' ? 'all' : 'down')}
            />
            <Kpi
              label="Belum diketahui"
              value={counts.unknown}
              tone="unknown"
              pressed={reachFilter === 'unknown'}
              onClick={() => setReachFilter(reachFilter === 'unknown' ? 'all' : 'unknown')}
            />
            <Kpi
              label="Data lama"
              value={counts.stale}
              tone="stale"
              pressed={freshFilter === 'stale'}
              onClick={() => setFreshFilter(freshFilter === 'stale' ? 'all' : 'stale')}
            />
          </section>

          <section className="panel toolbar" aria-label="Pencarian dan filter">
            <div className="field">
              <label htmlFor="ap-search">Cari nama/IP</label>
              <input
                id="ap-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="mis. ap-lantai2"
              />
            </div>
            <div className="field">
              <label htmlFor="fresh-filter">Kesegaran</label>
              <select id="fresh-filter" value={freshFilter} onChange={(event) => setFreshFilter(event.target.value)}>
                <option value="all">Semua</option>
                <option value="fresh">{FRESHNESS_LABEL.fresh}</option>
                <option value="stale">{FRESHNESS_LABEL.stale}</option>
                <option value="no_data">{FRESHNESS_LABEL.no_data}</option>
              </select>
            </div>
            {filtered && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setReachFilter('all');
                  setFreshFilter('all');
                }}
              >
                Bersihkan filter
              </button>
            )}
            <p className="sub" aria-live="polite">
              Menampilkan {visible.length} dari {devices.length} AP
            </p>
          </section>

          {devices.length === 0 ? (
            <section className="panel">
              <p>Belum ada perangkat terdaftar.</p>
              <button type="button" className="btn btn-primary" onClick={onManage}>
                Tambah AP di halaman Perangkat
              </button>
            </section>
          ) : visible.length === 0 ? (
            <p className="banner">Tidak ada AP yang cocok dengan pencarian/filter.</p>
          ) : (
            <section className="ap-grid" aria-label="Daftar AP">
              {visible.map((device) => (
                <ApCard
                  key={device.id}
                  device={device}
                  series={seriesByDevice.get(device.id) ?? null}
                  onSelect={() => onSelect(device.id)}
                />
              ))}
            </section>
          )}

          {summaryFailed && (
            <p className="banner banner-info">Sparkline 24 jam tidak tersedia (gagal memuat /api/summary).</p>
          )}
        </div>

        <aside className="stack" aria-label="Event terbaru">
          <section className="panel">
            <h3>Event terbaru</h3>
            {alerts.length === 0 ? (
              <p className="sub">Belum ada event.</p>
            ) : (
              <ul className="events">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <span className="event-head">
                      <span className="event-name">{alert.device_name ?? '—'}</span>
                      <span className="sub">{formatRelative(alert.started_at)}</span>
                    </span>
                    <span>{alert.detail?.transition ?? alert.type}</span>
                    <p className="sub">
                      {formatTime(alert.started_at)} · {alert.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, pressed, onClick }) {
  return (
    <button
      type="button"
      className={`kpi${tone ? ` kpi-${tone}` : ''}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </button>
  );
}

function Metric({ label, children }) {
  return (
    <span className="ap-metric">
      <span className="ap-metric-value">{children}</span>
      <span className="ap-metric-label">{label}</span>
    </span>
  );
}

function ApCard({ device, series, onSelect }) {
  const latency = device.last_ping?.latency_ms;
  const ram = device.metrics?.memory_used_percent?.value;
  const latencySeries = toPoints(series?.latency);
  const ramSeries = toPoints(series?.ram);
  return (
    <button type="button" className="ap-card" onClick={onSelect}>
      <span className="ap-card-head">
        <span className="ap-name">{device.name}</span>
        <ReachabilityBadge device={device} />
      </span>
      <span className="mono sub">{device.ip}</span>
      <span className="sub ap-collected" title={formatTime(device.last_collected_at)}>
        Koleksi terakhir: {device.last_collected_at ? `${formatTime(device.last_collected_at)} (${formatRelative(device.last_collected_at)})` : 'belum pernah'}
      </span>
      <span className="ap-metrics">
        <Metric label="Latency">{latency === null || latency === undefined ? '—' : `${num(latency, 1)} ms`}</Metric>
        <Metric label="RAM">{ram === null || ram === undefined ? '—' : `${num(ram, 1)} %`}</Metric>
        <Metric label="Uptime">{formatUptime(device.metrics?.uptime_seconds?.value)}</Metric>
        <Metric label="Kesegaran">
          <FreshnessBadge freshness={worstFreshness(device)} />
        </Metric>
      </span>
      <span className="ap-spark">
        <span className="sub">Latency {SPARK_RANGE}</span>
        <Chart compact values={latencySeries} label="Latency 24 jam" unit="ms" />
        <span className="sub">RAM {SPARK_RANGE}</span>
        <Chart compact values={ramSeries} label="RAM 24 jam" unit="%" />
      </span>
    </button>
  );
}
