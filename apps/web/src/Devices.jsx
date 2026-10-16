import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { StatusBadge } from './Badge.jsx';
import DeviceForm from './DeviceForm.jsx';

export default function Devices({ devices, loading, onReload }) {
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(null); // {device, probe}
  const [confirmId, setConfirmId] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set()); // himpunan id yang sedang sibuk
  const [notice, setNotice] = useState(null); // {tone: ok|warn|error, text}

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((device) =>
      `${device.name} ${device.ip} ${device.username ?? ''}`.toLowerCase().includes(q),
    );
  }, [devices, query]);

  // Penanda sibuk per perangkat: respons satu AP tidak boleh mencabut status AP lain.
  const markBusy = (id, busy) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const closeDrawer = async (saved) => {
    setDrawer(null);
    if (!saved) {
      setNotice({ tone: 'ok', text: 'Tidak ada perubahan yang perlu disimpan.' });
      return;
    }
    setNotice({ tone: 'ok', text: 'Perubahan AP disimpan.' });
    await onReload();
  };

  const patch = async (device, body, successText) => {
    markBusy(device.id, true);
    try {
      await api.updateDevice(device.id, body);
      setNotice({ tone: 'ok', text: successText });
      await onReload();
    } catch (err) {
      if (err.status !== 401) setNotice({ tone: 'error', text: `Gagal memperbarui ${device.name}: ${err.message}` });
    } finally {
      markBusy(device.id, false);
    }
  };

  const removeSecret = async (device) => {
    markBusy(device.id, true);
    try {
      await api.removeDeviceSecret(device.id);
      await onReload();
    } catch (err) {
      if (err.status !== 401) setNotice({ tone: 'error', text: `Gagal menghapus rahasia ${device.name}: ${err.message}` });
    } finally {
      markBusy(device.id, false);
    }
  };

  const remove = async (device) => {
    markBusy(device.id, true);
    try {
      await api.removeDevice(device.id);
      setNotice({ tone: 'ok', text: `${device.name} dihapus.` });
      await onReload();
    } catch (err) {
      if (err.status === 409 && err.code === 'device_has_history') {
        setNotice({
          tone: 'warn',
          text: `${device.name} punya histori monitoring, jadi tidak bisa dihapus. Nonaktifkan saja AP ini.`,
        });
      } else if (err.status !== 401) {
        setNotice({ tone: 'error', text: `Gagal menghapus ${device.name}: ${err.message}` });
      }
    } finally {
      setConfirmId(null);
      markBusy(device.id, false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Perangkat</h2>
          <p className="sub">Daftar AP yang dipantau collector (sumber: database).</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDrawer({ device: null, probe: false })}>
          Tambah AP
        </button>
      </div>

      {notice && (
        <p className={`banner banner-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      <section className="panel toolbar" aria-label="Pencarian perangkat">
        <div className="field">
          <label htmlFor="device-search">Cari nama/IP/pengguna</label>
          <input
            id="device-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="mis. 10.0.0.1"
          />
        </div>
        <p className="sub" aria-live="polite">
          Menampilkan {visible.length} dari {devices.length} AP
        </p>
      </section>

      {loading ? (
        <div className="stack" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <p className="banner">Belum ada perangkat terdaftar. Klik “Tambah AP” untuk mendaftarkan yang pertama.</p>
      ) : visible.length === 0 ? (
        <p className="banner">Tidak ada AP yang cocok dengan pencarian.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Daftar AP terdaftar beserta status kredensial dan aksi pengelolaan</caption>
            <thead>
              <tr>
                <th scope="col">Nama</th>
                <th scope="col">IP:port</th>
                <th scope="col">Pengguna</th>
                <th scope="col">Pemantauan</th>
                <th scope="col">Rahasia</th>
                <th scope="col">Fingerprint</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => {
                const busy = busyIds.has(device.id);
                const enabled = device.enabled === null || device.enabled === undefined ? null : Boolean(device.enabled);
                const hasSecret =
                  device.has_secret === null || device.has_secret === undefined ? null : Boolean(device.has_secret);
                const hasFingerprint = Boolean(device.host_key_fingerprint);
                return (
                  <tr key={device.id}>
                    <th scope="row">{device.name}</th>
                    <td className="mono num">
                      {device.ip ?? '—'}
                      {device.port ? `:${device.port}` : ''}
                    </td>
                    <td>{device.username || '—'}</td>
                    <td>
                      <StatusBadge
                        tone={enabled === null ? 'neutral' : enabled ? 'ok' : 'stale'}
                        label={enabled === null ? '—' : enabled ? 'Aktif' : 'Nonaktif'}
                      />
                    </td>
                    <td>
                      <StatusBadge
                        tone={hasSecret === null ? 'neutral' : hasSecret ? 'ok' : 'unknown'}
                        label={hasSecret === null ? '—' : hasSecret ? 'Terpasang' : 'Belum'}
                      />
                    </td>
                    <td>
                      <StatusBadge tone={hasFingerprint ? 'ok' : 'unknown'} label={hasFingerprint ? 'Terpasang' : 'Belum'} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => setDrawer({ device, probe: false })}
                        >
                          Ubah
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => setDrawer({ device, probe: true })}
                        >
                          Uji &amp; ambil fingerprint
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={busy || enabled === null}
                          onClick={() => patch(device, { enabled: !enabled }, `${device.name} ${enabled ? 'dinonaktifkan' : 'diaktifkan'}.`)}
                        >
                          {enabled ? 'Nonaktifkan' : 'Aktifkan'}
                        </button>
                        {hasSecret && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            disabled={busy}
                            onClick={() => removeSecret(device)}
                          >
                            Hapus rahasia
                          </button>
                        )}
                        {confirmId === device.id ? (
                          <>
                            <span className="field-error">Hapus permanen?</span>
                            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(device)}>
                              Ya, hapus
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => setConfirmId(null)}>
                              Batal
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            onClick={() => setConfirmId(device.id)}
                          >
                            Hapus
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <DeviceDrawer onClose={() => setDrawer(null)}>
          <DeviceForm
            key={drawer.device?.id ?? 'new'}
            device={drawer.device}
            autoProbe={drawer.probe}
            onClose={() => setDrawer(null)}
            onSaved={closeDrawer}
          />
        </DeviceDrawer>
      )}
    </div>
  );
}

// Panel samping: Esc menutup, klik latar menutup, fokus dipindah ke kontrol
// pertama dan dikembalikan ke tombol pemicu saat ditutup.
function DeviceDrawer({ children, onClose }) {
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // Jangan rebut fokus bila anak drawer (mis. form uji fingerprint) sudah fokus.
    if (panel && !panel.contains(document.activeElement)) {
      (panel.querySelector('input, select, textarea') ?? panel.querySelector('button'))?.focus();
    }
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      triggerRef.current?.focus?.();
    };
  }, []);


  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Form perangkat" ref={panelRef}>
        {children}
      </aside>
    </div>
  );
}
