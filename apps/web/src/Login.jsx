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
        <h1>Project Monitoring AP</h1>
        <label htmlFor="username">Nama pengguna</label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <label htmlFor="password">Kata sandi</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        {message && (
          <p className="banner error" role="alert">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}
