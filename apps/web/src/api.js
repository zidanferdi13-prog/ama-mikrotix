// Pembungkus REST + Socket.IO. Cookie sesi HttpOnly otomatis ikut (same-origin).
import { io } from 'socket.io-client';

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? 'request_failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  devices: () => request('/api/devices'),
  device: (id) => request(`/api/devices/${id}`),
  metrics: (id, { from, to, kind } = {}) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (kind) params.set('kind', kind);
    const qs = params.toString();
    return request(`/api/devices/${id}/metrics${qs ? `?${qs}` : ''}`);
  },
  alerts: (limit = 20) => request(`/api/alerts?limit=${limit}`),
  health: () => request('/api/health'),
};

// Reconnect → klien WAJIB refetch snapshot REST; server tidak memutar ulang event.
export function connectRealtime({ onRefresh, onStatus }) {
  const socket = io({ withCredentials: true, autoConnect: true });
  socket.on('connect', () => {
    onStatus('connected');
    onRefresh();
  });
  socket.on('disconnect', () => onStatus('disconnected'));
  socket.on('connect_error', () => onStatus('disconnected'));
  socket.on('metrics.updated', () => onRefresh());
  socket.on('device.status.changed', () => onRefresh());
  socket.on('alert.created', () => onRefresh());
  return () => socket.close();
}
