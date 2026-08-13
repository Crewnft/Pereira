import { randomUUID } from 'node:crypto';

const ALLOWED_TYPES = new Set(['acopio', 'riesgo', 'comercio']);
const DEVICE_COOKIE = 'pereira_device';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function resolveRedisConfig() {
  const pairs = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
  ];
  for (const [urlKey, tokenKey] of pairs) {
    if (process.env[urlKey] && process.env[tokenKey]) {
      return { url: process.env[urlKey], token: process.env[tokenKey] };
    }
  }
  return null;
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    return cookies;
  }, {});
}

function validType(type) {
  return typeof type === 'string' && ALLOWED_TYPES.has(type);
}

function validReportId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

async function redis(config, command) {
  const path = command.map(value => encodeURIComponent(String(value))).join('/');
  const response = await fetch(`${config.url}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` }
  });
  if (!response.ok) throw new Error('redis error');
  const payload = await response.json();
  if (payload.error) throw new Error('redis error');
  return payload.result;
}

function confirmationSet(type, reportId) {
  return `confirmations:${type}:${reportId}`;
}

function countsHash(type) {
  return `confirmation-counts:${type}`;
}

export default async function handler(req, res) {
  const config = resolveRedisConfig();
  if (!config) return res.status(500).json({ error: 'Redis no configurado.' });

  if (req.method === 'GET') {
    const { type } = req.query;
    if (!validType(type)) return res.status(400).json({ error: 'invalid type' });
    try {
      const raw = await redis(config, ['hgetall', countsHash(type)]);
      const counts = {};
      for (let index = 0; Array.isArray(raw) && index < raw.length; index += 2) {
        if (validReportId(raw[index])) counts[raw[index]] = Math.max(0, Number(raw[index + 1]) || 0);
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ counts });
    } catch {
      return res.status(500).json({ error: 'confirmation storage unavailable' });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { type, reportId } = body || {};
    if (!validType(type) || !validReportId(reportId)) return res.status(400).json({ error: 'invalid report' });

    const cookies = parseCookies(req.headers.cookie);
    let deviceId = cookies[DEVICE_COOKIE];
    if (!/^[a-f0-9-]{36}$/i.test(deviceId || '')) {
      deviceId = randomUUID();
      res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
    }

    try {
      const added = Number(await redis(config, ['sadd', confirmationSet(type, reportId), deviceId])) === 1;
      const confirmations = Math.max(0, Number(await redis(config, ['scard', confirmationSet(type, reportId)])) || 0);
      await redis(config, ['hset', countsHash(type), reportId, confirmations]);
      return res.status(200).json({ ok: true, added, confirmations, communityConfirmed: confirmations >= 5 });
    } catch {
      return res.status(500).json({ error: 'confirmation storage unavailable' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
