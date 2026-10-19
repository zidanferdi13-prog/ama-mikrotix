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

  clients: (id) => request(`/api/devices/${id}/clients`),
  deviceActions: (id, limit = 20) => request(`/api/devices/${id}/actions?limit=${limit}`),
  rebootDevice: (id, confirm) => request(`/api/devices/${id}/actions`, json('POST', { action: 'reboot', confirm })),
  alerts: (limit = 20) => request(`/api/alerts?limit=${limit}`),
  health: () => request('/api/health'),

  // Alert Center §8. Filter kosong tidak dikirim: server menolak nilai di luar daftar.
  alertCenter: (params) => request(`/api/alert-center${queryOf(params)}`),
  alertSummary: (params) => request(`/api/alerts/summary${queryOf(params)}`),
  alertDetail: (id) => request(`/api/alerts/${id}`),
  ackAlert: (id) => request(`/api/alerts/${id}/ack`, { method: 'POST' }),
  resolveAlert: (id) => request(`/api/alerts/${id}/resolve`, { method: 'POST' }),
};

function queryOf(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

// Reconnect → klien WAJIB refetch snapshot REST; server tidak memutar ulang event.
// onAlert dipakai Alert Center: event membawa id, jadi hanya detail itu yang disegarkan.
export function connectRealtime({ onRefresh, onStatus, onAlert }) {
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
  socket.on('alert.updated', (payload) => {
    if (onAlert) onAlert(payload);
    else onRefresh();
  });
  return () => socket.close();
}
