// Auth: JWT di HttpOnly cookie §7. Rahasia dari env, bukan repo.
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'ama_session';

function secret() {
  const s = process.env.AMA_JWT_SECRET;
  if (!s) throw new Error('AMA_JWT_SECRET not set');
  return s;
}

// Perbandingan waktu-tetap agar tidak membocorkan panjang/isi.
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function verifyCredentials(username, password) {
  const expectedUser = process.env.AMA_AUTH_USER;
  const expectedPass = process.env.AMA_AUTH_PASSWORD;
  if (!expectedUser || !expectedPass) return false;
  return safeEqual(username, expectedUser) && safeEqual(password, expectedPass);
}

export function issueToken(res, username) {
  const token = jwt.sign({ sub: username }, secret(), { expiresIn: process.env.AMA_JWT_TTL ?? '8h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.AMA_COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000,
  });
  return token;
}

export function clearToken(res) {
  res.clearCookie(COOKIE_NAME);
}

export function readToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const header = req.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret());
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const token = readToken(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    // Pesan gagal tidak membocorkan rincian kredensial.
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = payload.sub;
  return next();
}

// Socket.IO memakai aturan akses sama.
export function authenticateSocket(socket, next) {
  const cookieHeader = socket.handshake.headers?.cookie ?? '';
  const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const token = match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return next(new Error('unauthorized'));
  socket.data.user = payload.sub;
  return next();
}

export { COOKIE_NAME };
