// Daftar AP untuk collector. Sumber tunggal daftar perangkat adalah tabel devices
// (dikelola dari dashboard), bukan lagi berkas konfigurasi.
// Rahasia SSH tidak diambil di sini — collector membacanya lewat secrets.js.
export async function listCollectorDevices(pool) {
  const rows = await pool.query(
    `SELECT id, name, ip, port, username, host_key_fingerprint
     FROM devices WHERE enabled = 1 ORDER BY id`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    ip: row.ip,
    port: Number(row.port ?? 22),
    username: row.username,
    hostKeyFingerprint: row.host_key_fingerprint,
  }));
}
