// Aksi kontrol AP lewat SSH sesaat (mis. reboot). Pola sama dengan ssh-clients.js:
// host key WAJIB cocok dengan fingerprint tersimpan; password hanya di memori, tidak pernah ke log/respons.
import { createHash } from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import { sshCodeFor as codeFor } from '@ama/shared';

// Whitelist perintah tetap: nama aksi → string perintah. Tidak ada string dari pengguna.
export const ACTIONS = { reboot: 'reboot' };

const TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;
// Reboot memutus sesi; tunggu sebentar agar perintah tidak terpotong oleh penutupan kanal.
const GRACE_MS = 3_000;

function toFingerprint(hostHash) {
  const raw = Buffer.isBuffer(hostHash) ? hostHash : Buffer.from(String(hostHash), 'hex');
  return `sha256:${createHash('sha256').update(raw).digest('base64')}`;
}

// → { ok: true } bila AP menerima perintah; { ok: false, code } bila gagal sebelum/saat exec.
export async function runDeviceAction(
  { ip, port = 22, username, password, hostKeyFingerprint },
  action,
  { Client = SshClient, timeoutMs = TIMEOUT_MS, graceMs = GRACE_MS } = {},
) {
  const command = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!command) return { ok: false, code: 'unknown_action' };

  const conn = new Client();
  let hostKeyReason = null;
  let timer = null;

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('action_timeout'), { code: 'timeout' })), timeoutMs);
  });

  const work = (async () => {
    await new Promise((resolve, reject) => {
      conn
        .on('ready', resolve)
        .on('error', reject)
        .on('close', () => reject(new Error('closed_before_ready')))
        .connect({
          host: ip,
          port,
          username: username ?? undefined,
          password,
          readyTimeout: Math.min(READY_TIMEOUT_MS, timeoutMs),
          hostVerifier: (hostHash) => {
            if (!hostKeyFingerprint) {
              hostKeyReason = 'host_key_unpinned';
              return false;
            }
            if (toFingerprint(hostHash) !== hostKeyFingerprint) {
              hostKeyReason = 'host_key_changed';
              return false;
            }
            return true;
          },
        });
    });

    await new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(Object.assign(new Error('exec_failed'), { code: 'exec_failed' }));
          return;
        }
        // Perintah diterima. Exit non-nol (mis. izin ditolak) = gagal; putus/tanpa exit = terkirim.
        let exitCode = null;
        const grace = setTimeout(resolve, graceMs);
        stream.on('exit', (code) => {
          exitCode = code;
        });
        stream.on('data', () => {});
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(grace);
          if (typeof exitCode === 'number' && exitCode !== 0) {
            reject(Object.assign(new Error('exec_failed'), { code: 'exec_failed' }));
          } else resolve();
        });
        // Koneksi putus setelah exec diterima = AP sedang reboot.
        conn.removeAllListeners('error').removeAllListeners('close');
        conn.on('error', () => {}).on('close', () => {
          clearTimeout(grace);
          resolve();
        });
      });
    });
  })();

  try {
    work.catch(() => {});
    await Promise.race([work, deadline]);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err?.code === 'exec_failed' ? 'exec_failed' : codeFor(err, hostKeyReason) };
  } finally {
    clearTimeout(timer);
    conn.end();
    conn.destroy();
  }
}
