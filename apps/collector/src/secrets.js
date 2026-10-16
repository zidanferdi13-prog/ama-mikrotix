// Rahasia tidak boleh masuk Git, argumen command line, atau log.
// Prioritas: env AMA_DEVICE_<ID>_PASSWORD, lalu berkas JSON di AMA_SECRETS_FILE.
//
// Berkas rahasia dibaca ulang setiap kali dibutuhkan (ukurannya kecil): rahasia
// yang disimpan dari dashboard langsung terpakai pada siklus berikutnya, tanpa
// restart collector. Sebelumnya berkas di-cache selamanya sehingga rahasia AP
// baru tidak pernah terbaca.
import { readFileSync, existsSync } from 'node:fs';

function loadSecretFile(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function getDeviceSecret(deviceId) {
  const envKey = `AMA_DEVICE_${deviceId}_PASSWORD`;
  if (process.env[envKey]) return process.env[envKey];
  return loadSecretFile(process.env.AMA_SECRETS_FILE)[String(deviceId)] || null;
}

export function resolveSshAuth(device) {
  const password = getDeviceSecret(device.id);
  if (password) return { password };
  throw new Error(`no secret configured for device ${device.id}`);
}

// Jangan pernah menuliskan nilai rahasia ke log.
export function describeSecretSource(deviceId) {
  if (process.env[`AMA_DEVICE_${deviceId}_PASSWORD`]) return 'env';
  return process.env.AMA_SECRETS_FILE ? 'file' : 'none';
}
