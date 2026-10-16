// Alert Center §7: ringkasan, filter, daftar, detail dengan bukti + langkah, acknowledge.
// REST tetap sumber kebenaran: event realtime hanya memicu refetch (tidak menambal state).
import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { StatusBadge } from './Badge.jsx';
import { SIGNAL_LABEL, formatRelative, formatTime, signalTone } from './format.js';

const SEVERITY_LABEL = { critical: 'Kritis', warning: 'Peringatan', info: 'Info' };
const SEVERITY_TONE = { critical: 'down', warning: 'stale', info: 'neutral' };
const STATUS_LABEL = { active: 'Aktif', acknowledged: 'Diakui', resolved: 'Selesai' };
const STATUS_TONE = { active: 'down', acknowledged: 'partial', resolved: 'ok' };

const RANGES = [
  { key: '1h', label: '1 jam', ms: 3_600_000 },
  { key: '6h', label: '6 jam', ms: 6 * 3_600_000 },
  { key: '24h', label: '24 jam', ms: 24 * 3_600_000 },
];

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}h ${h}j`;
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

function Json({ value }) {
  if (value === null || value === undefined) return <p className="sub">Tidak ada.</p>;
  return <pre className="mono alert-json">{JSON.stringify(value, null, 2)}</pre>;
}

function List({ title, items }) {
  if (!items?.length) return null;
  return (
    <div className="alert-block">
      <h4 className="alert-block-title">{title}</h4>
      <ul className="alert-list">
        {items.map((text, index) => (
          <li key={`${index}-${String(text).slice(0, 24)}`}>{text}</li>
        ))}
      </ul>
    </div>
  );
}

export default function AlertCenter({ devices, refreshKey, alertEvent, onSelectDevice }) {
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [rangeKey, setRangeKey] = useState('24h');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const range = RANGES.find((item) => item.key === rangeKey) ?? RANGES[2];
  const periodParams = useCallback(() => {
    const to = new Date();
    const from = new Date(to.getTime() - range.ms);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [range]);

  const load = useCallback(async () => {
    const filters = { severity, status, device_id: deviceId, limit: 200 };
    try {
      const [list, ringkasan] = await Promise.all([
        api.alertCenter(filters),
        api.alertSummary(periodParams()),
      ]);
      setRows(list.alerts ?? []);
      setSummary(ringkasan);
      setError(null);
    } catch (err) {
      if (err.status !== 401) setError(err.code ?? 'gagal_memuat');
    } finally {
      setLoading(false);
    }
  }, [severity, status, deviceId, periodParams]);

  useEffect(() => {
    load();
  }, [load, refreshKey, alertEvent]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    api
      .alertDetail(selected)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled && err.status === 404) {
          setDetail(null);
          setSelected(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, refreshKey, alertEvent]);

  // Acknowledge tidak menyelesaikan insiden: status berubah, bukti tetap, riwayat bertambah.
  const act = async (fn, id) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn(id);
      await load();
      if (selected === id) setDetail(await api.alertDetail(id));
    } catch (err) {
      if (err.status !== 401) setActionError(err.code ?? 'aksi_gagal');
    } finally {
      setBusy(false);
    }
  };

  const onAlert = detail?.alert ?? null;
  const diagnosis = onAlert?.diagnosis ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Alert Center</h2>
          <p className="sub">
            Kondisi dipantau rule dengan ambang dan durasi; satu masalah tidak dihitung berkali-kali.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={busy}>
          Muat ulang
        </button>
      </div>

      {error && (
        <p className="banner banner-error" role="alert">
          Gagal memuat alert ({error}).
        </p>
      )}

      {summary && (
        <div className="kpi-strip">
          <div className="kpi">
            <span className="kpi-value">{summary.open}</span>
            <span className="kpi-label">Terbuka</span>
          </div>
          <div className="kpi kpi-down">
            <span className="kpi-value">{summary.by_severity.critical}</span>
            <span className="kpi-label">Kritis</span>
          </div>
          <div className="kpi kpi-stale">
            <span className="kpi-value">{summary.by_severity.warning}</span>
            <span className="kpi-label">Peringatan</span>
          </div>
          <div className="kpi kpi-unknown">
            <span className="kpi-value">{summary.by_severity.info}</span>
            <span className="kpi-label">Info</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{summary.by_status.acknowledged}</span>
            <span className="kpi-label">Diakui</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{summary.devices_affected}</span>
            <span className="kpi-label">AP terdampak</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{summary.resolved_in_period}</span>
            <span className="kpi-label">Selesai ({range.label})</span>
          </div>
          <div className={`kpi ${summary.collector.fresh ? 'kpi-ok' : 'kpi-down'}`}>
            <span className="kpi-value">{summary.collector.fresh ? 'sehat' : 'lambat'}</span>
            <span className="kpi-label">
              Collector {summary.collector.last_heartbeat_at ? formatRelative(summary.collector.last_heartbeat_at) : '—'}
            </span>
          </div>
        </div>
      )}

      {summary && !summary.collector.fresh && (
        <p className="banner banner-warn" role="status">
          Collector belum heartbeat terbaru. Data menua, jadi AP yang tidak terpantau belum berarti mati;
          alert per-AP ditahan sampai pengumpulan data normal.
        </p>
      )}

      <div className="toolbar">
        <label className="field">
          <span className="field-label">Severity</span>
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="">Semua</option>
            {Object.entries(SEVERITY_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Semua</option>
            {Object.entries(STATUS_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Perangkat</span>
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            <option value="">Semua</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Periode ringkasan">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className="nav-link"
              aria-current={rangeKey === item.key ? 'page' : undefined}
              onClick={() => setRangeKey(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="section-head">
          <h3>Daftar alert</h3>
          <span className="sub">{loading ? 'Memuat…' : `${rows.length} baris`}</span>
        </div>
        {rows.length === 0 && !loading ? (
          <p className="center">Tidak ada alert pada filter ini.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Judul</th>
                  <th>Perangkat</th>
                  <th>Target</th>
                  <th>Terakhir</th>
                  <th>Durasi</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selected ? 'row-selected' : undefined}>
                    <td>
                      <StatusBadge tone={SEVERITY_TONE[row.severity] ?? 'unknown'} label={SEVERITY_LABEL[row.severity] ?? row.severity} />
                    </td>
                    <td>
                      <StatusBadge tone={STATUS_TONE[row.status] ?? 'unknown'} label={STATUS_LABEL[row.status] ?? row.status} />
                    </td>
                    <td>
                      <div>{row.title}</div>
                      <span className="sub mono">{row.rule_id}</span>
                    </td>
                    <td>
                      {row.device_id === null ? (
                        <span className="sub">semua AP</span>
                      ) : (
                        <button type="button" className="link" onClick={() => onSelectDevice?.(row.device_id)}>
                          {row.device_name ?? `#${row.device_id}`}
                        </button>
                      )}
                      {row.reopen_count > 0 && <div className="sub">berulang ×{row.reopen_count}</div>}
                    </td>
                    <td className="mono">{row.target ?? '—'}</td>
                    <td>
                      {formatRelative(row.last_seen_at)}
                      <div className="sub">{formatTime(row.last_seen_at)}</div>
                    </td>
                    <td>{formatDuration(row.duration_ms)}</td>
                    <td className="row-actions">
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSelected(row.id)}>
                        Detail
                      </button>
                      {row.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => act(api.ackAlert, row.id)}
                        >
                          Acknowledge
                        </button>
                      )}
                      {row.status !== 'resolved' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => act(api.resolveAlert, row.id)}
                        >
                          Selesaikan
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {actionError && (
        <p className="banner banner-error" role="alert">
          Aksi gagal: {actionError}
        </p>
      )}

      {onAlert && (
        <div className="panel">
          <div className="section-head">
            <h3>Detail: {onAlert.title}</h3>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSelected(null)}>
              Tutup
            </button>
          </div>

          <dl className="identity">
            <div>
              <dt>Rule</dt>
              <dd className="mono">{onAlert.rule_id}</dd>
            </div>
            <div>
              <dt>Severity</dt>
              <dd>{SEVERITY_LABEL[onAlert.severity] ?? onAlert.severity}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{STATUS_LABEL[onAlert.status] ?? onAlert.status}</dd>
            </div>
            <div>
              <dt>Perangkat</dt>
              <dd>{onAlert.device_name ?? (onAlert.device_id === null ? 'semua AP' : `#${onAlert.device_id}`)}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd className="mono">{onAlert.target ?? '—'}</dd>
            </div>
            <div>
              <dt>Pertama terlihat</dt>
              <dd>{formatTime(onAlert.first_seen_at)}</dd>
            </div>
            <div>
              <dt>Terakhir diperbarui</dt>
              <dd>{formatTime(onAlert.last_seen_at)}</dd>
            </div>
            <div>
              <dt>Durasi</dt>
              <dd>{formatDuration(onAlert.duration_ms)}</dd>
            </div>
            <div>
              <dt>Diakui</dt>
              <dd>
                {onAlert.acknowledged_at
                  ? `${onAlert.acknowledged_by ?? '—'} · ${formatTime(onAlert.acknowledged_at)}`
                  : 'Belum'}
              </dd>
            </div>
            {onAlert.resolved_at && (
              <div>
                <dt>Selesai</dt>
                <dd>{formatTime(onAlert.resolved_at)}</dd>
              </div>
            )}
          </dl>

          <div className="row-actions alert-actions">
            {onAlert.status === 'active' && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(api.ackAlert, onAlert.id)}>
                Acknowledge
              </button>
            )}
            {onAlert.status !== 'resolved' && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act(api.resolveAlert, onAlert.id)}>
                Selesaikan
              </button>
            )}
          </div>

          {diagnosis && (
            <div className="alert-diagnosis">
              {diagnosis.scenario && (
                <p>
                  <strong>Korelasi skenario {diagnosis.scenario}</strong> · keyakinan{' '}
                  {diagnosis.confidence ?? '—'}
                  {diagnosis.confidence_rule ? ` (${diagnosis.confidence_rule})` : ''}
                </p>
              )}
              <List title="Bukti yang ada" items={diagnosis.evidence_present} />
              <List title="Bukti yang belum ada" items={diagnosis.evidence_missing} />
              {diagnosis.note && <p className="sub">{diagnosis.note}</p>}
              <List title="Langkah berikutnya" items={diagnosis.next_steps} />
              {diagnosis.affected_devices?.length > 0 && (
                <p className="sub">
                  AP terdampak: {diagnosis.affected_devices.map((deviceIdValue) => {
                    const device = devices.find((item) => item.id === deviceIdValue);
                    return device ? device.name : `#${deviceIdValue}`;
                  }).join(', ')}
                </p>
              )}
              {diagnosis.affected_clients?.length > 0 && (
                <p className="sub mono">Client terdampak: {diagnosis.affected_clients.join(', ')}</p>
              )}
            </div>
          )}

          <div className="alert-block">
            <h4 className="alert-block-title">Bukti mentah</h4>
            <Json value={onAlert.evidence} />
          </div>

          <div className="alert-block">
            <h4 className="alert-block-title">Riwayat status</h4>
            {detail.events.length === 0 ? (
              <p className="sub">Belum ada perubahan status.</p>
            ) : (
              <ul className="alert-list">
                {detail.events.map((event, index) => (
                  <li key={`${event.at}-${index}`}>
                    {formatTime(event.at)} · {event.from_status ?? '—'} → {event.to_status} · {event.actor}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {detail.context.related_alerts.length > 0 && (
            <div className="alert-block">
              <h4 className="alert-block-title">Alert perangkat terkait</h4>
              <ul className="alert-list">
                {detail.context.related_alerts.map((related) => (
                  <li key={related.id}>
                    <button type="button" className="link" onClick={() => setSelected(related.id)}>
                      {related.device_name ?? '—'} · {related.title}
                    </button>{' '}
                    <span className="sub">
                      {formatTime(related.first_seen_at)} · {STATUS_LABEL[related.status] ?? related.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.context.clients.length > 0 && (
            <div className="alert-block">
              <h4 className="alert-block-title">Client pada jendela insiden</h4>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>MAC</th>
                      <th>Snapshot</th>
                      <th>Terakhir terlihat</th>
                      <th>Sinyal terburuk</th>
                      <th>Sinyal terbaik</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.context.clients.map((client) => {
                      const worst = signalTone(client.worst_signal_dbm);
                      const best = signalTone(client.best_signal_dbm);
                      return (
                      <tr key={client.mac}>
                        <td className="mono">{client.mac}</td>
                        <td>{client.snapshots}</td>
                        <td>{formatTime(client.last_seen_at)}</td>
                        <td className={`num${worst ? ` sig-${worst}` : ''}`}>
                          {client.worst_signal_dbm ?? '—'} dBm
                          {worst && <span className="sub"> {SIGNAL_LABEL[worst]}</span>}
                        </td>
                        <td className={`num${best ? ` sig-${best}` : ''}`}>
                          {client.best_signal_dbm ?? '—'} dBm
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {detail.context.metrics.length > 0 && (
            <div className="alert-block">
              <h4 className="alert-block-title">Metrik jendela insiden</h4>
              <p className="sub">
                Sebelum {formatTime(detail.context.phases.before_from)} · selama{' '}
                {formatTime(detail.context.phases.during_from)} → {formatTime(detail.context.phases.during_to)}
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Waktu</th>
                      <th>Jenis</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>RAM</th>
                      <th>Load</th>
                      <th>Client</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.context.metrics.slice(-60).map((row) => (
                      <tr key={`${row.observed_at}-${row.kind}`}>
                        <td>{formatTime(row.observed_at)}</td>
                        <td>{row.kind}</td>
                        <td>
                          {row.kind === 'ping'
                            ? row.reachable === 1
                              ? 'terjangkau'
                              : row.reachable === 0
                                ? 'tidak terjangkau'
                                : '—'
                            : (row.collection_status ?? '—')}
                        </td>
                        <td>{row.latency_ms === null ? '—' : `${Number(row.latency_ms).toFixed(1)} ms`}</td>
                        <td>{row.memory_used_percent === null ? '—' : `${Number(row.memory_used_percent).toFixed(1)}%`}</td>
                        <td>{row.load_1 === null ? '—' : Number(row.load_1).toFixed(2)}</td>
                        <td>{row.client_count ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
