// Berkas rahasia JSON {"<device_id>": "<password>"} — dipakai bersama collector.
// Nilai rahasia tidak pernah masuk log, error, atau respons; yang bocor ke luar hanya boolean.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_PATH = '/etc/ama/secrets.json';

// Dibaca tiap panggilan (tanpa cache): server bisa menulis kapan saja.
function secretsPath() {
  return process.env.AMA_SECRETS_FILE || DEFAULT_PATH;
}

// Berkas hilang atau JSON rusak → objek kosong; server tidak boleh ikut mati.
export function readAll() {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

export function hasSecret(id) {
  const value = readAll()[String(id)];
  return typeof value === 'string' && value.length > 0;
}

// Tulis atomik: berkas sementara DI DIREKTORI YANG SAMA lalu rename; hasil akhir mode 0600.
function writeAll(data) {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function setSecret(id, password) {
  const data = readAll();
  data[String(id)] = password;
  writeAll(data);
}

// Hapus entri; berkas tetap ada (boleh jadi {}).
export function removeSecret(id) {
  const data = readAll();
  delete data[String(id)];
  writeAll(data);
}
