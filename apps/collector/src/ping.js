// Ping ICMP: keterjangkauan dari mesin collector, bukan bukti AP mati fisik.
import { execFile } from 'node:child_process';
import { TIMEOUT_MS } from '@ama/shared';

function buildArgs(host, timeoutMs) {
  if (process.platform === 'win32') {
    return ['-n', '1', '-w', String(timeoutMs), host];
  }
  return ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), host];
}

function parseLatencyMs(stdout) {
  const win = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
  if (win) return Number(win[1]);
  const nix = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
  return nix ? Number(nix[1]) : null;
}

// hasil: { reachable: boolean|null, latencyMs: number|null, code }
// reachable null berarti pemeriksaan sendiri tidak dapat dijalankan.
export function pingOnce(host, { timeoutMs = TIMEOUT_MS.ping } = {}) {
  return new Promise((resolve) => {
    execFile('ping', buildArgs(host, timeoutMs), { timeout: timeoutMs + 1000 }, (err, stdout) => {
      if (err) {
        const notRunnable = err.code === 'ENOENT';
        resolve({
          reachable: notRunnable ? null : false,
          latencyMs: null,
          code: notRunnable ? 'not_measured' : 'no_reply',
        });
        return;
      }
      resolve({ reachable: true, latencyMs: parseLatencyMs(stdout), code: null });
    });
  });
}

export async function collectPing(deviceId, host, options) {
  const observedAt = new Date().toISOString();
  const result = await pingOnce(host, options);
  return {
    device_id: deviceId,
    kind: 'ping',
    observed_at: observedAt,
    collection_status: result.reachable === null ? 'error' : 'ok',
    reachable: result.reachable,
    latency_ms: result.latencyMs,
    code: result.code,
  };
}
