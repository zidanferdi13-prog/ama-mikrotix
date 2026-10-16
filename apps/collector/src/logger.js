// Log aman: device id, waktu, durasi, status, kode error. Tanpa rahasia/isi mentah.
function emit(level, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const SAFE_KEYS = new Set([
  'event',
  'deviceId',
  'kind',
  'status',
  'durationMs',
  'code',
  'metric',
  'message',
  // Identitas AP (dilaporkan perangkat sendiri) — bukan rahasia, perlu saat firmware naik.
  'vendor',
  'model',
  'firmware',
]);

function sanitize(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

export const log = {
  info(fields) {
    emit('info', sanitize(fields));
  },
  warn(fields) {
    emit('warn', sanitize(fields));
  },
  error(fields) {
    emit('error', sanitize(fields));
  },
};
