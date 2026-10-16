// SSH read-only §4.1/§9. Host key diverifikasi; rahasia tidak masuk log/argv.
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import { TIMEOUT_MS, SYSTEM_COMMANDS } from '@ama/shared';
import { resolveSshAuth } from './secrets.js';

// Verifikasi host key: bandingkan dengan fingerprint tepercaya dari tabel devices.
// Host key berubah → hentikan koleksi dan laporkan.
function verifyHostKey(hostHash, expectedFingerprint) {
  const fingerprint = `sha256:${createHash('sha256').update(Buffer.from(hostHash, 'hex')).digest('base64')}`;
  if (!expectedFingerprint) {
    return { ok: false, reason: 'host_key_unpinned' };
  }
  if (fingerprint !== expectedFingerprint) {
    return { ok: false, reason: 'host_key_changed' };
  }
  return { ok: true, fingerprint };
}

function execCommand(conn, command, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        resolve({ ok: false, code: 'exec_failed' });
        return;
      }
      let stdout = '';
      stream.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ ok: true, stdout });
      });
    });
  });
}

// Ambil tiga perintah tetap; tutup koneksi di semua jalur.
export async function collectSystem(deviceId, device) {
  const observedAt = new Date().toISOString();
  const outputs = {};
  let auth = null;

  try {
    auth = resolveSshAuth(device);
  } catch {
    // Rahasia tidak ada/tidak terbaca: kegagalan koleksi, bukan penghentian siklus.
    return { observedAt, outputs, connectError: 'no_secret' };
  }

  const conn = new Client();

  let connectError = null;
  let hostKeyReason = null;

  const sessionTimer = setTimeout(() => conn.end(), TIMEOUT_MS.sshSession);

  try {
    await new Promise((resolve, reject) => {
      conn
        .on('ready', resolve)
        .on('error', reject)
        .on('close', () => reject(new Error('closed_before_ready')))
        .connect({
          host: device.ip,
          port: device.port ?? 22,
          username: device.username,
          ...auth,
          readyTimeout: TIMEOUT_MS.sshConnect,
          hostVerifier: (hostHash) => {
            const check = verifyHostKey(hostHash, device.hostKeyFingerprint);
            if (!check.ok) hostKeyReason = check.reason;
            return check.ok;
          },
        });
    });

    for (const command of SYSTEM_COMMANDS) {
      const res = await execCommand(conn, command, TIMEOUT_MS.sshCommand);
      if (command.includes('uptime')) outputs.uptime = res.ok ? res.stdout : undefined;
      else if (command.includes('loadavg')) outputs.loadavg = res.ok ? res.stdout : undefined;
      else if (command.includes('meminfo')) outputs.meminfo = res.ok ? res.stdout : undefined;
      else if (command.includes('mca-dump')) outputs.mcaDump = res.ok ? res.stdout : undefined;
    }
  } catch (err) {
    connectError = hostKeyReason ?? 'connect_failed';
  } finally {
    clearTimeout(sessionTimer);
    conn.end();
  }

  return { observedAt, outputs, connectError };
}
