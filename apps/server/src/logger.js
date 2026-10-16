// Log terstruktur satu baris. Kunci di-whitelist: nilai rahasia tidak mungkin ikut terbit,
// walau pemanggil keliru menyertakannya.
const SAFE_KEYS = ['event', 'deviceId', 'user', 'status', 'code'];

function emit(level, fields) {
  const out = { ts: new Date().toISOString(), level };
  for (const key of SAFE_KEYS) if (fields[key] !== undefined) out[key] = fields[key];
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

export const log = {
  info(fields) {
    emit('info', fields);
  },
};
