function resolveRedisConfig() {
  const pairs = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
  ];
  for (const [urlKey, tokenKey] of pairs) {
    if (process.env[urlKey] && process.env[tokenKey]) {
      return { url: process.env[urlKey], token: process.env[tokenKey], usedKeys: [urlKey, tokenKey] };
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const config = resolveRedisConfig();

  if (!config) {
    const present = Object.keys(process.env).filter(k => /REDIS|KV|UPSTASH/i.test(k));
    return res.status(500).json({
      error: 'No se encontro una base de datos Redis conectada a este proyecto.',
      envVarsFound: present
    });
  }

  if (req.method === 'GET') {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const r = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${config.token}` }
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(502).json({ error: 'upstash error', status: r.status, detail: txt, usedKeys: config.usedKeys });
      }
      const d = await r.json();
      return res.status(200).json({ value: d.result ?? null });
    } catch (e) {
      return res.status(500).json({ error: 'redis unreachable', detail: String(e) });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { key, value } = body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const r = await fetch(`${config.url}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'text/plain' },
        body: typeof value === 'string' ? value : JSON.stringify(value)
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(502).json({ error: 'upstash error', status: r.status, detail: txt, usedKeys: config.usedKeys });
      }
      const d = await r.json();
      return res.status(200).json({ ok: true, result: d.result });
    } catch (e) {
      return res.status(500).json({ error: 'redis unreachable', detail: String(e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
