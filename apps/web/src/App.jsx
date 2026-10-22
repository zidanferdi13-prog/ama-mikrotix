import React, { useCallback, useEffect, useState } from 'react';
import { api, connectRealtime, setUnauthorizedHandler } from './api.js';
import Login from './Login.jsx';
import Summary from './Summary.jsx';
import Detail from './Detail.jsx';
import Devices from './Devices.jsx';
import AlertCenter from './AlertCenter.jsx';
import Diagnose from './Diagnose.jsx';

export default function App() {
  const [authState, setAuthState] = useState('checking'); // checking | anon | authed
  const [view, setView] = useState({ name: 'summary' }); // summary | devices | alerts | detail
  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [realtime, setRealtime] = useState('connecting');
  const [refreshKey, setRefreshKey] = useState(0);
  const [alertEvent, setAlertEvent] = useState(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthState('anon'));
  }, []);

  const load = useCallback(async () => {
    try {
      const [devicesRes, alertsRes, healthRes] = await Promise.all([
        api.devices(),
        api.alerts(20),
        // /api/health 503 tetap membawa {ok, db, collector}: pakai isinya
        // supaya kode asli (collector_stale/no_heartbeat/db_unavailable) tidak hilang.
        api.health().catch((err) => err.body ?? { ok: false, db: { ok: false, code: 'unreachable' }, collector: { ok: false, code: 'unreachable' } }),
      ]);
      setDevices(devicesRes.devices ?? []);
      setAlerts(alertsRes.alerts ?? []);
      setHealth(healthRes);
      setError(null);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      if (err.status === 401) {
        setAuthState('anon');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthState('authed'))
      .catch(() => setAuthState('anon'));
  }, []);

  useEffect(() => {
    if (authState !== 'authed') return undefined;
    load();
    // Event alert menyegarkan daftar sekaligus menandai detail mana yang perlu di-refetch.
    const stop = connectRealtime({
      onRefresh: load,
      onStatus: setRealtime,
      onAlert: (payload) => {
        setAlertEvent(payload);
        load();
      },
    });
    return stop;
  }, [authState, load]);

  if (authState === 'checking') {
    return <div className="center">Memeriksa sesi…</div>;
  }

  if (authState === 'anon') {
    return (
      <Login
        onSuccess={() => {
          setLoading(true);
          setAuthState('authed');
        }}
      />
    );
  }

  const logout = async () => {
    await api.logout().catch(() => {});
    setAuthState('anon');
    setView({ name: 'summary' });
  };

  const collectorOk = Boolean(health?.collector?.ok);
  const collectorChip = !health
    ? { tone: 'unknown', text: 'Collector: tidak diketahui' }
    : collectorOk
      ? { tone: 'ok', text: 'Collector: sehat' }
      : { tone: 'down', text: `Collector: ${health.collector?.code ?? 'tidak sehat'}` };
  const realtimeChip =
    realtime === 'connected'
      ? { tone: 'ok', text: 'Realtime: terhubung' }
      : realtime === 'connecting'
        ? { tone: 'unknown', text: 'Realtime: menyambung…' }
        : { tone: 'down', text: 'Realtime: terputus' };

  const onSummary = !['devices', 'alerts', 'diagnose'].includes(view.name);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            AP
          </span>
          <span className="brand-name">Monitoring AP</span>
        </div>
        <nav className="nav" aria-label="Navigasi halaman">
          <button
            type="button"
            className="nav-link"
            aria-current={onSummary ? 'page' : undefined}
            onClick={() => setView({ name: 'summary' })}
          >
            Ringkasan
          </button>
          <button
            type="button"
            className="nav-link"
            aria-current={view.name === 'devices' ? 'page' : undefined}
            onClick={() => setView({ name: 'devices' })}
          >
            Perangkat
          </button>
          <button
            type="button"
            className="nav-link"
            aria-current={view.name === 'alerts' ? 'page' : undefined}
            onClick={() => setView({ name: 'alerts' })}
          >
            Alert Center
          </button>
          <button
            type="button"
            className="nav-link"
            aria-current={view.name === 'diagnose' ? 'page' : undefined}
            onClick={() => setView({ name: 'diagnose' })}
          >
            Diagnosa
          </button>
        </nav>
        <div className="topbar-right">
          <span className={`chip chip-${collectorChip.tone}`}>
            <span className="chip-dot" aria-hidden="true" />
            {collectorChip.text}
          </span>
          <span className={`chip chip-${realtimeChip.tone}`}>
            <span className="chip-dot" aria-hidden="true" />
            {realtimeChip.text}
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={logout}>
            Keluar
          </button>
        </div>
      </header>

      <div className="banners">
        {realtime === 'disconnected' && (
          <p className="banner banner-warn" role="status">
            Realtime terputus. Data terakhir tetap ditampilkan; snapshot disinkronkan saat tersambung lagi.
          </p>
        )}
        {health && !collectorOk && (
          <p className="banner banner-warn" role="status">
            Collector tidak sehat ({health.collector?.code ?? 'penyebab tidak diketahui'}). Data bisa menua.
          </p>
        )}
        {health?.db && health.db.ok === false && (
          <p className="banner banner-error" role="status">
            Database tidak tersedia ({health.db.code ?? 'db_unavailable'}). Data tidak dapat diperbarui.
          </p>
        )}
        {error && (
          <p className="banner banner-error" role="alert">
            Gagal memuat data: {error}
          </p>
        )}
      </div>

      {view.name === 'diagnose' ? (
        <Diagnose devices={devices} />
      ) : view.name === 'devices' ? (
        <Devices devices={devices} loading={loading} onReload={load} />
      ) : view.name === 'alerts' ? (
        <AlertCenter
          devices={devices}
          refreshKey={refreshKey}
          alertEvent={alertEvent}
          onSelectDevice={(id) => setView({ name: 'detail', id })}
        />
      ) : view.name === 'detail' ? (
        <Detail id={view.id} onBack={() => setView({ name: 'summary' })} />
      ) : (
        <Summary
          devices={devices}
          alerts={alerts}
          loading={loading}
          refreshKey={refreshKey}
          onSelect={(id) => setView({ name: 'detail', id })}
          onManage={() => setView({ name: 'devices' })}
        />
      )}
    </div>
  );
}
