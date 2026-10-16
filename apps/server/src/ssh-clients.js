// Daftar client Wi-Fi live via `mca-dump` (read-only). Koneksi sesaat, bukan kolektor.
// Host key WAJIB cocok dengan fingerprint tersimpan: server tidak menyambung ke AP asing.
// Password hanya dipakai di memori proses; tidak pernah masuk log, error, atau respons.
import { createHash } from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import { mapClients, sshCodeFor as codeFor } from '@ama/shared';

// Perintah tetap, tanpa string dari pengguna.
const CLIENT_COMMAND = 'mca-dump';
const TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;

// Format sama dengan collector (apps/collector/src/ssh.js): sha256 atas byte host key.
function toFingerprint(hostHash) {
  const raw = Buffer.isBuffer(hostHash) ? hostHash : Buffer.from(String(hostHash), 'hex');
  return `sha256:${createHash('sha256').update(raw).digest('base64')}`;
}

// Sambung, verifikasi host key, jalankan mca-dump, putuskan. Selalu tutup koneksi.
export async function listClients(
  { ip, port = 22, username, password, hostKeyFingerprint },
  { Client = SshClient, timeoutMs = TIMEOUT_MS } = {},
) {
  const conn = new Client();
  let hostKeyReason = null;
  let timer = null;

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('clients_timeout'), { code: 'timeout' })), timeoutMs);
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
            const expected = hostKeyFingerprint;
            if (!expected) {
              hostKeyReason = 'host_key_unpinned';
              return false;
            }
            if (toFingerprint(hostHash) !== expected) {
              hostKeyReason = 'host_key_changed';
              return false;
            }
            return true;
          },
        });
    });

    const stdout = await new Promise((resolve, reject) => {
      conn.exec(CLIENT_COMMAND, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let out = '';
        stream.on('data', (chunk) => {
          out += chunk.toString('utf8');
        });
        stream.stderr.on('data', () => {});
        stream.on('close', () => resolve(out));
      });
    });

    const mapped = mapClients(stdout);
    if (!mapped.ok) throw Object.assign(new Error('parse_failed'), { code: 'parse_failed' });
    return mapped;
  })();

  try {
    // Pekerjaan yang gagal setelah deadline menang sudah tidak relevan; jangan jadi unhandled rejection.
    work.catch(() => {});
    const mapped = await Promise.race([work, deadline]);
    return {
      ok: true,
      clients: mapped.clients,
      total: mapped.total,
      truncated: mapped.truncated,
      observedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, code: codeFor(err, hostKeyReason) };
  } finally {
    // Selalu tutup: sesi yang macet tidak selalu selesai lewat end() saja.
    clearTimeout(timer);
    conn.end();
    conn.destroy();
  }
}
