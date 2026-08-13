import { createHash } from 'node:crypto';

const CACHE_SECONDS = 60 * 60 * 24 * 30;
const PEREIRA_VIEWBOX = '-75.85,4.95,-75.55,4.70';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }

  const query = String(req.query.q || '').trim().slice(0, 200);
  if (query.length < 5) return res.status(400).json({ error: 'Escribe una dirección más completa.' });
  const config = resolveRedisConfig();
  if (!config) return res.status(500).json({ error: 'Búsqueda de direcciones no configurada.' });

  const normalized = `${query}, Pereira, Risaralda, Colombia`.toLowerCase();
  const cacheKey = `geocode:${createHash('sha256').update(normalized).digest('hex')}`;
  try {
    const cached = await redis(config, ['get', cacheKey]);
    if (cached) return res.status(200).json(JSON.parse(cached));

    const lock = await redis(config, ['set', 'geocode:nominatim-lock', '1', 'nx', 'ex', '1']);
    if (lock !== 'OK') return res.status(429).json({ error: 'La búsqueda está ocupada. Inténtalo nuevamente en un segundo.' });

    const params = new URLSearchParams({
      q: normalized, format: 'jsonv2', limit: '1', countrycodes: 'co',
      viewbox: PEREIRA_VIEWBOX, bounded: '1', addressdetails: '0', 'accept-language': 'es'
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: {
        'User-Agent': 'PereiraEmergencia/1.0 (https://pereira-emergencia.vercel.app)',
        Referer: 'https://pereira-emergencia.vercel.app/'
      }
    });
    if (!response.ok) throw new Error('geocoder error');
    const results = await response.json();
    const first = Array.isArray(results) ? results[0] : null;
    const lat = Number(first && first.lat);
    const lng = Number(first && first.lon);
    const payload = Number.isFinite(lat) && Number.isFinite(lng)
      ? { found: true, lat, lng, label: String(first.display_name || query).slice(0, 300) }
      : { found: false };
    await redis(config, ['set', cacheKey, JSON.stringify(payload), 'ex', CACHE_SECONDS]);
    return res.status(200).json(payload);
  } catch {
    return res.status(502).json({ error: 'No fue posible buscar la dirección.' });
  }
}
