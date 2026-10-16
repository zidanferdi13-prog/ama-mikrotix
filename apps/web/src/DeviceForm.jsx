// Form tambah/ubah AP. Rahasia SSH hanya hidup di state komponen ini:
// tidak pernah ditulis ke localStorage, dikirim hanya saat simpan/uji.
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Kode validasi server → kalimat Indonesia.
const FIELD_MESSAGE = {
  required: 'Wajib diisi.',
  too_long: 'Terlalu panjang.',
  invalid_ip: 'Alamat IP tidak valid.',
  invalid_port: 'Port harus 1–65535.',
  invalid_fingerprint: 'Fingerprint harus berformat sha256:…',
  invalid_type: 'Jenis nilai salah.',
  invalid_password: 'Kata sandi 1–200 karakter.',
};

const fieldMessage = (code) => FIELD_MESSAGE[code] ?? `Tidak valid (${code}).`;

function emptyForm() {
  return {
    name: '',
    ip: '',
    port: '22',
    username: '',
    vendor: '',
    model: '',
    firmware: '',
    host_key_fingerprint: '',
    notes: '',
    enabled: true,
  };
}

function toForm(device) {
  return {
    name: device.name ?? '',
    ip: device.ip ?? '',
    port: device.port === null || device.port === undefined ? '22' : String(device.port),
    username: device.username ?? '',
    vendor: device.vendor ?? '',
    model: device.model ?? '',
    firmware: device.firmware ?? '',
    host_key_fingerprint: device.host_key_fingerprint ?? '',
    notes: device.notes ?? '',
    enabled: device.enabled === null || device.enabled === undefined ? true : Boolean(device.enabled),
  };
}

// Bentuk payload tulis dari state form ('' = kosongkan nilai).
function buildBody(source) {
  return {
    name: source.name.trim(),
    ip: source.ip.trim(),
    port: source.port.trim() === '' ? 22 : Number(source.port),
    username: source.username.trim(),
    vendor: source.vendor.trim(),
    model: source.model.trim(),
    firmware: source.firmware.trim(),
    host_key_fingerprint: source.host_key_fingerprint.trim(),
    notes: source.notes.trim(),
    enabled: source.enabled,
  };
}

// Hanya field yang berbeda dari snapshot awal: PATCH parsial tidak menimpa
// perubahan yang lebih baru (mis. AP dinonaktifkan dari sesi lain).
function diffBody(next, base) {
  const body = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== base[key]) body[key] = value;
  }
  return body;
}

export default function DeviceForm({ device, autoProbe = false, onClose, onSaved }) {
  const [form, setForm] = useState(() => (device ? toForm(device) : emptyForm()));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState({ state: 'idle' });
  const passwordRef = useRef(null);

  useEffect(() => {
    if (autoProbe) passwordRef.current?.focus();
  }, [autoProbe]);

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const port = form.port.trim() === '' ? 22 : Number(form.port);

  // Snapshot keadaan yang dibuka dari server, dasar perbandingan PATCH.
  const snapshotRef = useRef(null);
  if (snapshotRef.current === null) snapshotRef.current = buildBody(device ? toForm(device) : emptyForm());

  const payload = () => {
    const next = buildBody(form);
    const body = device ? diffBody(next, snapshotRef.current) : next;
    if (password) body.password = password;
    return body;
  };

  const runProbe = async () => {
    setFieldErrors({});
    if (!password) {
      setProbe({ state: 'error', message: 'Isi kata sandi SSH dulu sebelum menguji.' });
      passwordRef.current?.focus();
      return;
    }
    setProbe({ state: 'busy' });
    try {
      const result = await api.probeDevice({
        ip: form.ip.trim(),
        port,
        username: form.username.trim(),
        password,
      });
      setProbe({ state: 'done', fingerprint: result?.fingerprint ?? null });
    } catch (err) {
      if (err.status === 400 && err.fields) {
        setFieldErrors(err.fields);
        setProbe({ state: 'idle' });
      } else if (err.status === 401) {
        setProbe({ state: 'idle' });
      } else if (err.status === 502) {
        setProbe({ state: 'error', message: `Uji koneksi gagal (${err.reason ?? 'penyebab tidak diketahui'}).` });
      } else {
        setProbe({ state: 'error', message: `Uji koneksi gagal: ${err.message}` });
      }
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    const body = payload();
    if (device && Object.keys(body).length === 0) {
      // Tidak ada perubahan: tutup tanpa request.
      onSaved(null);
      return;
    }
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const saved = device ? await api.updateDevice(device.id, body) : await api.createDevice(body);
      onSaved(saved?.device ?? saved ?? null);
    } catch (err) {
      if (err.status === 400 && err.fields) {
        setFieldErrors(err.fields);
        setFormError('Periksa isian yang ditandai.');
      } else if (err.status === 409 && err.code === 'ip_taken') {
        setFormError('IP itu sudah dipakai AP lain.');
      } else if (err.status === 404) {
        setFormError('Perangkat tidak ditemukan (mungkin sudah dihapus).');
      } else if (err.status !== 401) {
        setFormError(`Gagal menyimpan: ${err.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const errorOf = (key) => (fieldErrors[key] ? fieldMessage(fieldErrors[key]) : null);
  const aria = (key) => ({
    'aria-invalid': fieldErrors[key] ? true : undefined,
    'aria-describedby': fieldErrors[key] ? `${key}-error` : undefined,
  });

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="drawer-head">
        <h2>{device ? `Ubah ${device.name}` : 'Tambah AP'}</h2>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
          Tutup
        </button>
      </div>

      {formError && (
        <p className="banner banner-error" role="alert">
          {formError}
        </p>
      )}

      <div className="form-grid">
        <Field id="name" label="Nama" error={errorOf('name')}>
          <input id="name" value={form.name} onChange={set('name')} maxLength={120} required {...aria('name')} />
        </Field>
        <Field id="ip" label="Alamat IP" error={errorOf('ip')}>
          <input id="ip" className="mono" value={form.ip} onChange={set('ip')} inputMode="decimal" required {...aria('ip')} />
        </Field>
        <Field id="port" label="Port SSH" error={errorOf('port')} hint="Default 22.">
          <input id="port" type="number" min="1" max="65535" value={form.port} onChange={set('port')} {...aria('port')} />
        </Field>
        <Field id="username" label="Pengguna SSH" error={errorOf('username')}>
          <input id="username" value={form.username} onChange={set('username')} maxLength={80} autoComplete="off" {...aria('username')} />
        </Field>
        <Field
          id="password"
          label="Kata sandi SSH"
          error={errorOf('password')}
          hint={device ? 'Biarkan kosong bila tidak diubah.' : undefined}
        >
          <span className="input-row">
            <input
              id="password"
              ref={passwordRef}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              maxLength={200}
              {...aria('password')}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? 'Sembunyikan' : 'Tampilkan'}
            </button>
          </span>
        </Field>
        <Field id="vendor" label="Vendor" error={errorOf('vendor')}>
          <input id="vendor" value={form.vendor} onChange={set('vendor')} maxLength={80} {...aria('vendor')} />
        </Field>
        <Field id="model" label="Model" error={errorOf('model')}>
          <input id="model" value={form.model} onChange={set('model')} maxLength={120} {...aria('model')} />
        </Field>
        <Field id="firmware" label="Firmware" error={errorOf('firmware')}>
          <input id="firmware" value={form.firmware} onChange={set('firmware')} maxLength={80} {...aria('firmware')} />
        </Field>
        <Field
          id="host_key_fingerprint"
          label="Fingerprint host key"
          error={errorOf('host_key_fingerprint')}
          hint="Format sha256:… Kosongkan bila belum diverifikasi."
        >
          <input
            id="host_key_fingerprint"
            className="mono"
            value={form.host_key_fingerprint}
            onChange={set('host_key_fingerprint')}
            placeholder="sha256:…"
            {...aria('host_key_fingerprint')}
          />
        </Field>
        <Field id="notes" label="Catatan" error={errorOf('notes')}>
          <input id="notes" value={form.notes} onChange={set('notes')} maxLength={255} {...aria('notes')} />
        </Field>
        <div className="field check">
          <input id="enabled" type="checkbox" checked={form.enabled} onChange={set('enabled')} />
          <label htmlFor="enabled">Aktif (dipantau collector)</label>
        </div>
      </div>

      <section className={`probe-result${autoProbe ? ' probe-focus' : ''}`} aria-label="Uji koneksi SSH">
        <h3>Uji koneksi &amp; fingerprint</h3>
        <p className="sub">
          Menguji {form.ip.trim() || '(IP belum diisi)'}:{port} sebagai {form.username.trim() || '(pengguna belum diisi)'} memakai
          kata sandi di form ini. Fingerprint hasil uji baru dipakai setelah form disimpan.
        </p>
        <div className="input-row">
          <button type="button" className="btn btn-secondary" onClick={runProbe} disabled={probe.state === 'busy'}>
            {probe.state === 'busy' ? 'Menguji…' : 'Uji & ambil fingerprint'}
          </button>
          {probe.state === 'done' && probe.fingerprint && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setForm((prev) => ({ ...prev, host_key_fingerprint: probe.fingerprint }));
                setFieldErrors((prev) => ({ ...prev, host_key_fingerprint: undefined }));
              }}
            >
              Pakai fingerprint ini
            </button>
          )}
        </div>
        {probe.state === 'done' && (
          <p className="mono">
            {probe.fingerprint ? probe.fingerprint : 'Uji berhasil, tetapi server tidak mengirim fingerprint.'}
          </p>
        )}
        {probe.state === 'error' && (
          <p className="field-error" role="alert">
            {probe.message}
          </p>
        )}
      </section>

      <div className="row-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Batal
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Menyimpan…' : device ? 'Simpan perubahan' : 'Simpan AP'}
        </button>
      </div>
    </form>
  );
}

function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </div>
  );
}
