// Rahasia tidak boleh masuk Git, argumen command line, atau log.
// Prioritas: env AMA_DEVICE_<ID>_PASSWORD, lalu file JSON di AMA_SECRETS_FILE.
import { readFileSync, existsSync } from 'node:fs';

let cache = null;

function loadSecretFile() {
  const path = process.env.AMA_SECRETS_FILE;
  if (!path) return {};
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function getDeviceSecret(deviceId) {
  const envKey = `AMA_DEVICE_${deviceId}_PASSWORD`;
  if (process.env[envKey]) return process.env[envKey];
  if (cache === null) cache = loadSecretFile();
  return cache[String(deviceId)] ?? null;
}

export function resolveSshAuth(device) {
  const password = getDeviceSecret(device.id);
  if (password) return { password };
  if (device.privateKeyPath) {
    return { privateKey: readFileSync(device.privateKeyPath) };
  }
  throw new Error(`no secret configured for device ${device.id}`);
}

// Jangan pernah menuliskan nilai rahasia ke log.
export function describeSecretSource(deviceId) {
  if (process.env[`AMA_DEVICE_${deviceId}_PASSWORD`]) return 'env';
  return process.env.AMA_SECRETS_FILE ? 'file' : 'none';
}
