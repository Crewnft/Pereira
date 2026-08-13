import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const ALLOWED_NEEDS = new Set(['water', 'food', 'clothing', 'medical', 'shelter', 'hygiene', 'baby']);
const ALLOWED_SHELTERS = new Set(['ecoparque-el-vergel', 'parque-el-oso', 'coliseo-mayor', 'parque-olaya-herrera', 'estadio-mora-mora']);
const DEVICE_COOKIE = 'pereira_device';
const MODERATOR_COOKIE = 'pereira_moderator';
const COMMUNITY_THRESHOLD = 5;

function resolveRedisConfig() {
  const pairs = [['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN']];
  for (const [urlKey, tokenKey] of pairs) if (process.env[urlKey] && process.env[tokenKey]) return { url: process.env[urlKey], token: process.env[tokenKey] };
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

function parseCookies(header) {
  return String(header || '').split(';').reduce((result, part) => {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return result;
  }, {});
}

function validShelterId(value) { return typeof value === 'string' && ALLOWED_SHELTERS.has(value); }
function validProposalId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }

function moderatorAuthorized(req) {
  const secret = process.env.MODERATOR_SESSION_SECRET;
  if (!secret) return false;
  const token = parseCookies(req.headers.cookie)[MODERATOR_COOKIE] || '';
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(expires).digest('hex');
  try { return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

async function hashToObject(config, key) {
  const raw = await redis(config, ['hgetall', key]);
  const result = {};
  for (let index = 0; Array.isArray(raw) && index < raw.length; index += 2) {
    try { result[raw[index]] = JSON.parse(raw[index + 1]); } catch { /* Ignorar datos inválidos. */ }
  }
  return result;
}

async function publishProposal(config, proposal, status) {
  const update = { needs: proposal.needs, updatedAt: new Date().toISOString(), source: status };
  await redis(config, ['hset', 'shelter-needs', proposal.shelterId, JSON.stringify(update)]);
  proposal.status = status;
  proposal.resolvedAt = update.updatedAt;
  await redis(config, ['hset', 'shelter-need-proposals', proposal.id, JSON.stringify(proposal)]);
  return update;
}

export default async function handler(req, res) {
  const config = resolveRedisConfig();
  if (!config) return res.status(500).json({ error: 'Redis no configurado.' });

  try {
    if (req.method === 'GET') {
      const updates = await hashToObject(config, 'shelter-needs');
      const proposals = await hashToObject(config, 'shelter-need-proposals');
      const pending = Object.values(proposals).filter(item => item && item.status === 'pending').map(item => ({ id: item.id, shelterId: item.shelterId, needs: item.needs, createdAt: item.createdAt, confirmations: Number(item.confirmations || 0) }));
      const payload = { updates, pending };
      if (moderatorAuthorized(req)) payload.moderator = true;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(payload);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const action = body && body.action || 'propose';

      if (action === 'propose') {
        const shelterId = body.shelterId;
        const needs = Array.isArray(body.needs) ? [...new Set(body.needs.filter(item => ALLOWED_NEEDS.has(item)))].slice(0, 7) : [];
        if (!validShelterId(shelterId) || !needs.length) return res.status(400).json({ error: 'Selecciona al menos una necesidad.' });
        const cookies = parseCookies(req.headers.cookie);
        let deviceId = cookies[DEVICE_COOKIE];
        if (!/^[a-f0-9-]{36}$/i.test(deviceId || '')) {
          deviceId = randomUUID();
          res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        }
        const allowed = await redis(config, ['set', `shelter-need-proposal-rate:${deviceId}`, '1', 'nx', 'ex', '60']);
        if (allowed !== 'OK') return res.status(429).json({ error: 'Espera un minuto antes de enviar otra propuesta.' });
        const proposal = { id: randomUUID(), shelterId, needs, createdAt: new Date().toISOString(), confirmations: 0, status: 'pending' };
        await redis(config, ['hset', 'shelter-need-proposals', proposal.id, JSON.stringify(proposal)]);
        return res.status(200).json({ ok: true, proposal });
      }

      if (action === 'confirm') {
        if (!validProposalId(body.proposalId)) return res.status(400).json({ error: 'Propuesta inválida.' });
        const serialized = await redis(config, ['hget', 'shelter-need-proposals', body.proposalId]);
        const proposal = serialized ? JSON.parse(serialized) : null;
        if (!proposal || proposal.status !== 'pending') return res.status(404).json({ error: 'La propuesta ya no está pendiente.' });
        const cookies = parseCookies(req.headers.cookie);
        let deviceId = cookies[DEVICE_COOKIE];
        if (!/^[a-f0-9-]{36}$/i.test(deviceId || '')) {
          deviceId = randomUUID();
          res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        }
        const added = Number(await redis(config, ['sadd', `shelter-need-confirmations:${proposal.id}`, deviceId])) === 1;
        proposal.confirmations = Number(await redis(config, ['scard', `shelter-need-confirmations:${proposal.id}`])) || 0;
        let update = null;
        if (proposal.confirmations >= COMMUNITY_THRESHOLD) update = await publishProposal(config, proposal, 'community-confirmed');
        else await redis(config, ['hset', 'shelter-need-proposals', proposal.id, JSON.stringify(proposal)]);
        return res.status(200).json({ ok: true, added, proposal, update });
      }

      if (['approve', 'reject', 'remove'].includes(action)) {
        if (!moderatorAuthorized(req)) return res.status(401).json({ error: 'No autorizado.' });
        if (action === 'remove') {
          if (!validShelterId(body.shelterId)) return res.status(400).json({ error: 'Albergue inválido.' });
          await redis(config, ['hdel', 'shelter-needs', body.shelterId]);
          return res.status(200).json({ ok: true });
        }
        if (!validProposalId(body.proposalId)) return res.status(400).json({ error: 'Propuesta inválida.' });
        const serialized = await redis(config, ['hget', 'shelter-need-proposals', body.proposalId]);
        const proposal = serialized ? JSON.parse(serialized) : null;
        if (!proposal || proposal.status !== 'pending') return res.status(404).json({ error: 'Propuesta no disponible.' });
        if (action === 'approve') return res.status(200).json({ ok: true, update: await publishProposal(config, proposal, 'moderator-verified') });
        proposal.status = 'rejected'; proposal.resolvedAt = new Date().toISOString();
        await redis(config, ['hset', 'shelter-need-proposals', proposal.id, JSON.stringify(proposal)]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Acción inválida.' });
    }
  } catch {
    return res.status(500).json({ error: 'No fue posible actualizar las necesidades.' });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
