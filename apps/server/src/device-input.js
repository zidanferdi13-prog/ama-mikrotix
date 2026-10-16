// Validasi payload tulis device (§kontrak). `password` dipisah dari kolom device.
import { isIP } from 'node:net';

const FINGERPRINT_RE = /^sha256:[A-Za-z0-9+/]{43}=$/;

// Kolom teks opsional: kosong → null.
const TEXT_LIMITS = {
  username: 80,
  vendor: 80,
  model: 120,
  firmware: 80,
  notes: 255,
};

function present(src, key) {
  return src[key] !== undefined && src[key] !== null;
}

function parsePassword(value) {
  if (value === undefined || value === null || value === '') return { password: null };
  if (typeof value !== 'string' || value.length > 200) return { error: 'invalid_password' };
  return { password: value };
}

function parseText(fields, errors, src, key, max) {
  if (!present(src, key)) return;
  const value = src[key];
  if (typeof value !== 'string') {
    errors[key] = 'invalid_type';
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fields[key] = null;
  } else if (trimmed.length > max) {
    errors[key] = 'too_long';
  } else {
    fields[key] = trimmed;
  }
}

function parseFingerprint(fields, errors, src) {
  if (!present(src, 'host_key_fingerprint')) return;
  const value = src.host_key_fingerprint;
  if (typeof value !== 'string') {
    errors.host_key_fingerprint = 'invalid_type';
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) fields.host_key_fingerprint = null;
  else if (!FINGERPRINT_RE.test(trimmed)) errors.host_key_fingerprint = 'invalid_fingerprint';
  else fields.host_key_fingerprint = trimmed;
}

// partial=true (PATCH): field yang absen tidak divalidasi dan tidak diikutkan hasil.
export function parseDeviceInput(body, { partial = false } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const fields = {};
  const errors = {};

  if (!present(src, 'name')) {
    if (!partial) errors.name = 'required';
  } else if (typeof src.name !== 'string') {
    errors.name = 'invalid_type';
  } else if (src.name.trim().length === 0) {
    errors.name = 'required';
  } else if (src.name.trim().length > 120) {
    errors.name = 'too_long';
  } else {
    fields.name = src.name.trim();
  }

  if (!present(src, 'ip')) {
    if (!partial) errors.ip = 'required';
  } else if (typeof src.ip !== 'string') {
    errors.ip = 'invalid_type';
  } else if (isIP(src.ip.trim()) === 0) {
    errors.ip = 'invalid_ip';
  } else {
    fields.ip = src.ip.trim();
  }

  if (!present(src, 'port')) {
    if (!partial) fields.port = 22;
  } else {
    const value = src.port;
    const num = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isInteger(num)) errors.port = 'invalid_type';
    else if (num < 1 || num > 65535) errors.port = 'invalid_port';
    else fields.port = num;
  }

  for (const [key, max] of Object.entries(TEXT_LIMITS)) parseText(fields, errors, src, key, max);
  parseFingerprint(fields, errors, src);

  if (!present(src, 'enabled')) {
    if (!partial) fields.enabled = true;
  } else if (typeof src.enabled !== 'boolean') {
    errors.enabled = 'invalid_type';
  } else {
    fields.enabled = src.enabled;
  }

  const { password, error } = parsePassword(src.password);
  if (error) errors.password = error;

  // Kolom opsional pada POST dinormalkan ke null agar INSERT seragam.
  if (!partial) {
    for (const key of Object.keys(TEXT_LIMITS)) if (!(key in fields)) fields[key] = null;
    if (!('host_key_fingerprint' in fields)) fields.host_key_fingerprint = null;
  }

  if (Object.keys(errors).length > 0) return { ok: false, fields: errors };
  // `password` sengaja terpisah; tidak pernah masuk objek kolom/device.
  return { ok: true, value: { fields, password } };
}

// Probe: butuh ip, port (opsional), username, dan password untuk sekali sambung.
export function parseProbeInput(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const fields = {};
  const errors = {};

  if (typeof src.ip !== 'string' || isIP(src.ip.trim()) === 0) {
    errors.ip = src.ip === undefined || src.ip === null ? 'required' : 'invalid_ip';
  } else {
    fields.ip = src.ip.trim();
  }

  if (src.port === undefined || src.port === null) {
    fields.port = 22;
  } else {
    const value = src.port;
    const num = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isInteger(num)) errors.port = 'invalid_type';
    else if (num < 1 || num > 65535) errors.port = 'invalid_port';
    else fields.port = num;
  }

  if (src.username !== undefined && src.username !== null) {
    if (typeof src.username !== 'string') errors.username = 'invalid_type';
    else {
      const trimmed = src.username.trim();
      if (trimmed.length > 80) errors.username = 'too_long';
      else fields.username = trimmed.length === 0 ? null : trimmed;
    }
  }

  const { password, error } = parsePassword(src.password);
  if (error || password === null) errors.password = 'invalid_password';
  else fields.password = password;

  if (Object.keys(errors).length > 0) return { ok: false, fields: errors };
  return { ok: true, value: fields };
}
