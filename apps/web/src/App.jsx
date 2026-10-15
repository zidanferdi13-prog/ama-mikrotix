import React, { useCallback, useEffect, useState } from 'react';
import { api, connectRealtime } from './api.js';
import Login from './Login.jsx';
import Summary from './Summary.jsx';
import Detail from './Detail.jsx';

export default function App() {
  const [authState, setAuthState] = useState('checking'); // checking | anon | authed
  const [view, setView] = useState({ name: 'summary' });
  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [realtime, setRealtime] = useState('connecting');

  const load = useCallback(async () => {
    try {
      const [devicesRes, alertsRes, healthRes] = await Promise.all([
        api.devices(),
        api.alerts(20),
        api.health().catch((e) => ({ ok: false, code: e.message })),
      ]);
      setDevices(devicesRes.devices);
      setAlerts(alertsRes.alerts);
      setHealth(healthRes);
      setError(null);
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
      .then(() => {
        setAuthState('authed');
      })
      .catch(() => setAuthState('anon'));
  }, []);

  useEffect(() => {
    if (authState !== 'authed') return undefined;
    load();
    const stop = connectRealtime({ onRefresh: load, onStatus: setRealtime });
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
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Project Monitoring AP</h1>
        <div className="topbar-status">
          <span>Collector: {health?.collector?.ok ? 'sehat' : 'tidak sehat'}</span>
          <span className={`pill realtime-${realtime}`}>Realtime: {realtime === 'connected' ? 'terhubung' : 'terputus'}</span>
          <button type="button" onClick={logout}>
            Keluar
          </button>
        </div>
      </header>

      {realtime !== 'connected' && (
        <div className="banner warn" role="status">
          Realtime terputus. Menampilkan data terakhir; sinkronisasi ulang saat tersambung.
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          Gagal memuat data: {error}
        </div>
      )}
      {health && !health.collector?.ok && (
        <div className="banner warn" role="status">
          Collector tidak sehat ({health.collector?.code ?? 'tidak diketahui'}). Data bisa menua.
        </div>
      )}

      {view.name === 'summary' ? (
        <Summary
          devices={devices}
          alerts={alerts}
          loading={loading}
          onSelect={(id) => setView({ name: 'detail', id })}
        />
      ) : (
        <Detail id={view.id} onBack={() => setView({ name: 'summary' })} />
      )}
    </div>
  );
}
