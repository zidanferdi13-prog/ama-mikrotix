// Probe host key: SEKALI sambung hanya untuk melaporkan fingerprint yang ditawarkan server.
// Host key yang didapat TIDAK dipercaya otomatis — ini pelaporan, bukan pinning.
import { createHash } from 'node:crypto';
import { Client as SshClient } from 'ssh2';

const READY_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 12_000;

// Format sama dengan collector (apps/collector/src/ssh.js): sha256 atas byte host key.
function toFingerprint(hostHash) {
  const raw = Buffer.isBuffer(hostHash) ? hostHash : Buffer.from(String(hostHash), 'hex');
  return `sha256:${createHash('sha256').update(raw).digest('base64')}`;
}

function codeFor(err) {
  if (err?.code === 'timeout') return 'timeout';
  if (err?.level === 'client-timeout') return 'timeout';
  if (err?.level === 'client-authentication') return 'auth_failed';
  return 'connect_failed';
}

export async function probeHostKey(
  { ip, port = 22, username, password },
  { Client = SshClient, sessionTimeoutMs = SESSION_TIMEOUT_MS } = {},
) {
  const conn = new Client();
  let fingerprint = null;
  let timer = null;

  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('probe timeout'), { code: 'timeout' })), sessionTimeoutMs);

      conn
        .on('ready', resolve)
        .on('error', reject)
        .on('close', () => reject(new Error('closed_before_ready')))
        .connect({
          host: ip,
          port,
          username: username ?? undefined,
          password,
          readyTimeout: READY_TIMEOUT_MS,
          // Terima host key apa pun; nilainya hanya dilaporkan ke pemanggil.
          hostVerifier: (hostHash) => {
            fingerprint = toFingerprint(hostHash);
            return true;
          },
        });
    });
    if (!fingerprint) return { ok: false, code: 'connect_failed' };
    return { ok: true, fingerprint };
  } catch (err) {
    return { ok: false, code: codeFor(err) };
  } finally {
    // Selalu tutup: handshake yang macet tidak selalu selesai lewat end() saja.
    clearTimeout(timer);
    conn.end();
    conn.destroy();
  }
}
