const ALLOWED_NEEDS = new Set(['water', 'food', 'clothing', 'medical', 'shelter', 'hygiene', 'baby']);

function resolveRedisConfig() {
  const pairs = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
  ];
  for (const [urlKey, tokenKey] of pairs) {
    if (process.env[urlKey] && process.env[tokenKey]) return { url: process.env[urlKey], token: process.env[tokenKey] };
  }
  return null;
}

async function redis(config, command) {
  const path = command.map(value => encodeURIComponent(String(value))).join('/');
  const response = await fetch(`${config.url}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` } });
  if (!response.ok) throw new Error('redis error');
  const payload = await response.json();
  if (payload.error) throw new Error('redis error');
  return payload.result;
}

function validShelterId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);
}

export default async function handler(req, res) {
  const config = resolveRedisConfig();
  if (!config) return res.status(500).json({ error: 'Redis no configurado.' });
  const key = 'shelter-needs';

  try {
    if (req.method === 'GET') {
      const raw = await redis(config, ['hgetall', key]);
      const updates = {};
      for (let index = 0; Array.isArray(raw) && index < raw.length; index += 2) {
        try { if (validShelterId(raw[index])) updates[raw[index]] = JSON.parse(raw[index + 1]); } catch { /* Ignorar datos inválidos. */ }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ updates });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const shelterId = body && body.shelterId;
      const needs = Array.isArray(body && body.needs) ? [...new Set(body.needs.filter(item => ALLOWED_NEEDS.has(item)))].slice(0, 7) : [];
      if (!validShelterId(shelterId) || needs.length === 0) return res.status(400).json({ error: 'Selecciona al menos una necesidad.' });
      const update = { needs, updatedAt: new Date().toISOString(), source: 'community' };
      await redis(config, ['hset', key, shelterId, JSON.stringify(update)]);
      return res.status(200).json({ ok: true, update });
    }
  } catch {
    return res.status(500).json({ error: 'No fue posible actualizar las necesidades.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
