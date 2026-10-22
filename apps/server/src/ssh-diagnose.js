// Cek live untuk tombol Diagnosa: satu sesi SSH (host key tersemat), beberapa perintah baca
// tetap dijalankan paralel. Tidak ada string dari pengguna yang masuk ke perintah; IP gateway
// berasal dari tabel route AP dan divalidasi sebagai IPv4 sebelum dipakai.
import { createHash } from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import { mapClients, normalizeSystemSample, parseInternetPing, sshCodeFor } from '@ama/shared';

const TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 5_000;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ping = (host) => `ping -c 3 -w 4 ${host} 2>&1`;

function toFingerprint(hostHash) {
  const raw = Buffer.isBuffer(hostHash) ? hostHash : Buffer.from(String(hostHash), 'hex');
  return `sha256:${createHash('sha256').update(raw).digest('base64')}`;
}

export function gatewayFrom(routeText) {
  const m = String(routeText ?? '').match(/^default via (\S+)/m);
  return m && IPV4.test(m[1]) ? m[1] : null;
}

function exec(conn, command) {
  return new Promise((resolve) => {
    conn.exec(command, (err, stream) => {
      if (err) return resolve(undefined);
      let out = '';
      stream.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve(out));
      return undefined;
    });
  });
}

// → { ok, code?, gatewayIp, gateway, publicIp, internet, sample, clients, total, observedAt }
export async function diagnoseLive(
  { id, ip, port = 22, username, password, hostKeyFingerprint },
  { Client = SshClient, timeoutMs = TIMEOUT_MS } = {},
) {
  const conn = new Client();
  let hostKeyReason = null;
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('diagnose_timeout'), { code: 'timeout' })), timeoutMs);
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
            if (!hostKeyFingerprint) hostKeyReason = 'host_key_unpinned';
            else if (toFingerprint(hostHash) !== hostKeyFingerprint) hostKeyReason = 'host_key_changed';
            return !hostKeyReason;
          },
        });
    });

    const route = await exec(conn, 'ip route');
    const gatewayIp = gatewayFrom(route);
    const [gw, pub, net, uptime, loadavg, meminfo, mcaDump] = await Promise.all([
      gatewayIp ? exec(conn, ping(gatewayIp)) : Promise.resolve(undefined),
      exec(conn, ping('8.8.8.8')),
      exec(conn, ping('google.com')),
      exec(conn, 'cat /proc/uptime'),
      exec(conn, 'cat /proc/loadavg'),
      exec(conn, 'cat /proc/meminfo'),
      exec(conn, 'mca-dump'),
    ]);
    const observedAt = new Date().toISOString();
    const mapped = mapClients(mcaDump);
    return {
      ok: true,
      observedAt,
      gatewayIp,
      gateway: gatewayIp ? parseInternetPing(gw) : null,
      publicIp: parseInternetPing(pub),
      internet: parseInternetPing(net),
      sample: normalizeSystemSample({ deviceId: id, observedAt, outputs: { uptime, loadavg, meminfo, mcaDump, internet: net } }),
      clients: mapped.ok ? mapped.clients : [],
      total: mapped.ok ? mapped.total : null,
    };
  })();

  try {
    work.catch(() => {});
    return await Promise.race([work, deadline]);
  } catch (err) {
    return { ok: false, code: sshCodeFor(err, hostKeyReason) };
  } finally {
    clearTimeout(timer);
    conn.end();
    conn.destroy();
  }
}
