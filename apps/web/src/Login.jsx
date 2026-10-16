import React, { useState } from 'react';
import { api } from './api.js';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.login(username, password);
      onSuccess();
    } catch {
      // Pesan tidak membocorkan bagian kredensial mana yang salah.
      setMessage('Nama pengguna atau kata sandi salah.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="login-head">
          <span className="brand-mark" aria-hidden="true">
            AP
          </span>
          <div>
            <h1>Monitoring AP</h1>
            <p className="sub">Masuk untuk memantau access point.</p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="username">Nama pengguna</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Kata sandi</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        {message && (
          <p className="banner banner-error" role="alert">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}
