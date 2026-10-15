// Konfigurasi tanpa rahasia. Rahasia diambil lewat secrets.js (env/file di luar repo).
import { readFileSync } from 'node:fs';

export function loadCollectorConfig(configPath = process.env.AMA_CONFIG ?? './config/devices.json') {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return {
    devices: (raw.devices ?? []).map((d) => ({ ...d, id: Number(d.id) })),
    healthPath: raw.healthPath ?? './.runtime/collector-health.json',
  };
}
