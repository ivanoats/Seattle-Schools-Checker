import { authorized } from './ingest.js';
import { accessConfig, accessIdentity } from './pilot-auth.js';
import { buildFamilyReport } from '../core/family-report.js';

export const privateHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'Vary': 'Cf-Access-Jwt-Assertion',
};
const reply = (status, body) => Response.json(body, { status, headers: privateHeaders });
const result = async statement => (await statement.all()).results;
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');

async function readBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_request');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('invalid_request'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function originAllowed(request, env) {
  const url = new URL(request.url);
  return url.origin === env.APP_ORIGIN && url.protocol === 'https:' &&
    request.headers.get('Origin') === env.APP_ORIGIN &&
    request.headers.get('X-Pilot-Request') === '1';
}

async function membership(db, identity) {
  return (await result(db.prepare(`SELECT m.family_id, m.selected_child_id FROM pilot_members m
    JOIN pilot_families f ON f.id = m.family_id
    WHERE m.subject = ? AND m.email = ? AND f.revoked_at IS NULL`)
    .bind(identity.subject, identity.email)))[0] ?? null;
}

async function createInvite(request, env, now) {
  if (!await authorized(request, env.PILOT_ADMIN_TOKEN)) return reply(404, { status: 'not_found' });
  const input = await readBody(request);
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply(400, { status: 'invalid_request' });
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(now + 7 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO pilot_families (id, created_at) VALUES (?, ?)').bind(familyId, new Date(now).toISOString()),
    env.DB.prepare('INSERT INTO pilot_invites (token_hash, family_id, email, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hash(token), familyId, email, expiresAt),
  ]);
  // Fragment keeps the bearer invitation out of HTTP URLs and access logs.
  return reply(201, { status: 'invited', familyId, expiresAt, url: `${env.APP_ORIGIN}/app#invite=${token}` });
}

async function acceptInvite(request, env, identity, now) {
  const { token } = await readBody(request);
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return reply(400, { status: 'invalid_invitation' });
  const digest = await hash(token);
  const timestamp = new Date(now).toISOString();
  // Both statements run in one D1 transaction. The SELECT conditions also
  // make replays and concurrent claims safe; no read-then-write grant.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO pilot_members (subject, family_id, email, created_at)
      SELECT ?, i.family_id, i.email, ? FROM pilot_invites i
      JOIN pilot_families f ON f.id = i.family_id
      WHERE i.token_hash = ? AND i.email = ? AND i.expires_at > ?
        AND (i.claimed_by IS NULL OR i.claimed_by = ?) AND f.revoked_at IS NULL`)
      .bind(identity.subject, timestamp, digest, identity.email, timestamp, identity.subject),
    env.DB.prepare(`UPDATE pilot_invites SET claimed_by = ? WHERE token_hash = ? AND email = ?
      AND expires_at > ? AND (claimed_by IS NULL OR claimed_by = ?)
      AND EXISTS (SELECT 1 FROM pilot_members m WHERE m.subject = ? AND m.family_id = pilot_invites.family_id)`)
      .bind(identity.subject, digest, identity.email, timestamp, identity.subject, identity.subject),
  ]);
  const invite = (await result(env.DB.prepare('SELECT claimed_by FROM pilot_invites WHERE token_hash = ?').bind(digest)))[0];
  return invite?.claimed_by === identity.subject && await membership(env.DB, identity)
    ? reply(200, { status: 'accepted' }) : reply(403, { status: 'invitation_not_available' });
}

export async function handlePilot(request, env, options = {}) {
  const url = new URL(request.url);
  const now = options.now ?? Date.now();
  if (!env.DB || !accessConfig(env) || !env.APP_ORIGIN || url.origin !== env.APP_ORIGIN) {
    return reply(503, { status: 'pilot_not_configured' });
  }
  if (!['GET', 'POST'].includes(request.method)) return reply(405, { status: 'method_not_allowed' });
  if (request.method === 'POST' && !originAllowed(request, env)) return reply(403, { status: 'request_not_allowed' });
  try {
    if (url.pathname === '/api/pilot/operator/invites' && request.method === 'POST') return await createInvite(request, env, now);
    const identity = await accessIdentity(request, env, options);
    if (!identity) return reply(401, { status: 'sign_in_required' });
    if (url.pathname === '/api/pilot/invitation' && request.method === 'POST') return await acceptInvite(request, env, identity, now);
    const member = await membership(env.DB, identity);
    if (!member) return reply(403, { status: 'invitation_required' });
    if (url.pathname === '/api/pilot/session' && request.method === 'GET') {
      return reply(200, { status: 'ok', email: identity.email, selectedChildId: member.selected_child_id,
        connectionsAvailable: false });
    }
    if (url.pathname === '/api/pilot/children' && request.method === 'GET') {
      const children = await result(env.DB.prepare('SELECT id, display_name AS displayName FROM pilot_children WHERE family_id = ? ORDER BY display_name, id').bind(member.family_id));
      return reply(200, { status: 'ok', children });
    }
    if (url.pathname === '/api/pilot/selection' && request.method === 'POST') {
      const { childId } = await readBody(request);
      if (typeof childId !== 'string' || childId.length > 64) return reply(400, { status: 'invalid_request' });
      const rows = await result(env.DB.prepare(`UPDATE pilot_members SET selected_child_id = ? WHERE subject = ? AND family_id = ?
        AND EXISTS (SELECT 1 FROM pilot_children WHERE family_id = ? AND id = ?) RETURNING selected_child_id`)
        .bind(childId, identity.subject, member.family_id, member.family_id, childId));
      return rows.length ? reply(200, { status: 'selected', childId }) : reply(404, { status: 'child_not_found' });
    }
    if (url.pathname === '/api/pilot/report' && request.method === 'GET') {
      const childId = url.searchParams.get('childId');
      const child = (await result(env.DB.prepare('SELECT id, display_name AS displayName FROM pilot_children WHERE family_id = ? AND id = ?')
        .bind(member.family_id, childId)))[0];
      if (!child) return reply(404, { status: 'child_not_found' });
      const providers = await Promise.all(['source', 'schoology'].map(async provider => {
        const query = `SELECT status, reason, attempted_at, observed_at, observation FROM provider_checks
          WHERE family_id = ? AND child_id = ? AND provider = ?`;
        const latest = (await result(env.DB.prepare(`${query} ORDER BY attempted_at DESC, received_at DESC LIMIT 1`)
          .bind(member.family_id, childId, provider)))[0];
        const verified = (await result(env.DB.prepare(`${query} AND status = 'ok' ORDER BY attempted_at DESC, received_at DESC LIMIT 1`)
          .bind(member.family_id, childId, provider)))[0];
        return { provider, lastStatus: latest?.status ?? 'not_checked', lastAttemptAt: latest?.attempted_at ?? null,
          lastReason: latest?.reason ?? null, observedAt: verified?.observed_at ?? null,
          observation: verified ? JSON.parse(verified.observation) : null };
      }));
      const observations = Object.fromEntries(providers.map(p => [p.provider, p.observation]));
      const report = buildFamilyReport({ childId, ...observations, cutoff: new Date(now).toISOString() });
      return reply(200, { status: 'ok', child, providers: providers.map(({ observation, ...p }) => p), report });
    }
    return reply(404, { status: 'not_found' });
  } catch {
    // Never return exception messages, request bodies, or student records in errors.
    return reply(400, { status: 'request_failed' });
  }
}
