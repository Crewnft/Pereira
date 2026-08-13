const ALLOWED_KEYS = new Set(['acopio-reports', 'riesgo-reports']);
const MAX_VALUE_BYTES = 250000;

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

function allowedKey(key) {
  return typeof key === 'string' && ALLOWED_KEYS.has(key);
}

export default async function handler(req, res) {
  const config = resolveRedisConfig();
  if (!config) return res.status(500).json({ error: 'Redis no configurado.' });

  if (req.method === 'GET') {
    const { key } = req.query;
    if (!allowedKey(key)) return res.status(400).json({ error: 'invalid key' });
    try {
      const r = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${config.token}` }
      });
      if (!r.ok) return res.status(502).json({ error: 'storage error' });
      const d = await r.json();
      return res.status(200).json({ value: d.result ?? null });
    } catch {
      return res.status(500).json({ error: 'storage unavailable' });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { key, value } = body || {};
    if (!allowedKey(key)) return res.status(400).json({ error: 'invalid key' });
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(serialized || '', 'utf8') > MAX_VALUE_BYTES) {
      return res.status(413).json({ error: 'payload too large' });
    }
    try {
      const r = await fetch(`${config.url}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'text/plain' },
        body: serialized
      });
      if (!r.ok) return res.status(502).json({ error: 'storage error' });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'storage unavailable' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
