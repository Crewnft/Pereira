import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'pereira_moderator';
const SESSION_MS = 8 * 60 * 60 * 1000;

function safeEqual(left, right) {
  try { return timingSafeEqual(Buffer.from(String(left)), Buffer.from(String(right))); } catch { return false; }
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((result, part) => { const i = part.indexOf('='); if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim(); return result; }, {});
}

function authorized(req) {
  const secret = process.env.MODERATOR_SESSION_SECRET;
  const [expires, signature] = (parseCookies(req.headers.cookie)[COOKIE] || '').split('.');
  if (!secret || !expires || Number(expires) < Date.now()) return false;
  return safeEqual(signature, createHmac('sha256', secret).update(expires).digest('hex'));
}

export default async function handler(req, res) {
  const password = process.env.MODERATOR_PASSWORD;
  const secret = process.env.MODERATOR_SESSION_SECRET;
  if (!password || !secret) return res.status(503).json({ error: 'Modo moderador no configurado.' });
  if (req.method === 'GET') return res.status(200).json({ authenticated: authorized(req) });
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'POST') {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!safeEqual(body && body.password, password)) return res.status(401).json({ error: 'Credencial incorrecta.' });
    const expires = String(Date.now() + SESSION_MS);
    const signature = createHmac('sha256', secret).update(expires).digest('hex');
    res.setHeader('Set-Cookie', `${COOKIE}=${expires}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return res.status(200).json({ ok: true });
  }
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
}
