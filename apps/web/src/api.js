// Pembungkus REST + Socket.IO. Cookie sesi HttpOnly otomatis ikut (same-origin).
// Tidak ada token/rahasia yang disimpan di localStorage.
import { io } from 'socket.io-client';

// Dipanggil saat server menjawab 401 agar shell kembali ke halaman masuk.
let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : null),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    unauthorizedHandler?.();
    const err = new Error('unauthorized');
    err.status = 401;
    err.code = 'unauthorized';
    throw err;
  }

  if (res.status === 204) return null;

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? 'request_failed');
    err.status = res.status;
    err.code = body.error ?? 'request_failed';
    err.fields = body.fields ?? null; // {field: kode_validasi}
    err.reason = body.code ?? null; // kode rinci, mis. probe_failed
    err.body = body; // isi mentah: /api/health 503 membawa {ok, db, collector}
    throw err;
  }

  return res.json();
}

const json = (method, payload) => ({ method, body: JSON.stringify(payload ?? {}) });

export const api = {
  login: (username, password) => request('/api/auth/login', json('POST', { username, password })),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  devices: () => request('/api/devices'),
  createDevice: (payload) => request('/api/devices', json('POST', payload)),
  updateDevice: (id, payload) => request(`/api/devices/${id}`, json('PATCH', payload)),
  removeDevice: (id) => request(`/api/devices/${id}`, { method: 'DELETE' }),
  removeDeviceSecret: (id) => request(`/api/devices/${id}/secret`, { method: 'DELETE' }),
  probeDevice: (payload) => request('/api/devices/probe', json('POST', payload)),
  summary: (range = '1h') => request(`/api/summary?range=${encodeURIComponent(range)}`),

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
