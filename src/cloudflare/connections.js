import { authorized } from './ingest.js';
import { digest, randomToken, sealCredentials, openCredentials, validKey } from './connection-crypto.js';
import { configuredChild } from '../core/children.js';

const providers = ['source', 'schoology'];
const rows = async stmt => (await stmt.all()).results;
const iso = now => new Date(now).toISOString();
const tokenName = provider => `${provider.toUpperCase()}_DISCOVERY_TOKEN`;
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, data) => Response.json(data, { status, headers });
export function connectionAvailable(env, provider) {
  return providers.includes(provider) && env[`${provider.toUpperCase()}_CONNECTIONS_ENABLED`] === 'true'
    && validKey(env.CONNECTION_KEY) && validKey(env[tokenName(provider)])
    && (provider !== 'schoology' || Boolean(env.BROWSER));
}

// Expire instead of retrying a possibly completed sign-in. Parents explicitly
// submit another attempt after reviewing attention status.
async function expireJobs(env, now, familyId = null) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE pilot_connections SET status = 'attention', reason = 'discovery_expired', updated_at = ?
      WHERE (? IS NULL OR family_id = ?) AND status IN ('queued', 'discovering') AND EXISTS (
        SELECT 1 FROM pilot_discovery_jobs j WHERE j.connection_id = pilot_connections.id
        AND j.revision = pilot_connections.revision AND j.state IN ('queued', 'running')
        AND (j.expires_at <= ? OR (j.state = 'running' AND j.lease_expires_at <= ?)))`).bind(iso(now), familyId, familyId, iso(now), iso(now)),
    env.DB.prepare(`UPDATE pilot_discovery_jobs SET state = 'cancelled' WHERE state IN ('queued', 'running')
      AND (expires_at <= ? OR (state = 'running' AND lease_expires_at <= ?))
      AND (? IS NULL OR connection_id IN (SELECT id FROM pilot_connections WHERE family_id = ?))`)
      .bind(iso(now), iso(now), familyId, familyId),
  ]);
}

export async function connectionSummary(env, member, now) {
  await expireJobs(env, now, member.family_id);
  const connections = await rows(env.DB.prepare(`SELECT id, provider, status, reason, submitted_at, updated_at
    FROM pilot_connections WHERE family_id = ?`).bind(member.family_id));
  return Promise.all(providers.map(async provider => {
    const connection = connections.find(c => c.provider === provider);
    const candidates = connection?.status === 'ready' ? await rows(env.DB.prepare(`SELECT k.id, k.display_name AS displayName,
      p.child_id AS linkedChildId FROM pilot_candidates k JOIN pilot_connections c ON c.id = k.connection_id
      LEFT JOIN pilot_child_providers p ON p.connection_id = k.connection_id AND p.revision = k.revision AND p.remote_id = k.remote_id
      WHERE c.family_id = ? AND c.provider = ? AND k.revision = c.revision ORDER BY k.display_name, k.id`)
      .bind(member.family_id, provider)) : [];
    return { provider, available: connectionAvailable(env, provider), status: connection?.status ?? 'not_connected',
      reason: connection?.reason ?? null, updatedAt: connection?.updated_at ?? null, candidates };
  }));
}

export async function submitConnection(env, member, provider, input, now) {
  if (!connectionAvailable(env, provider)) return reply(503, { status: 'connection_not_available' });
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!username || username.length > 254 || typeof input.password !== 'string' || !input.password || input.password.length > 2048) {
    return reply(400, { status: 'credentials_required' });
  }
  await expireJobs(env, now, member.family_id);
  const existing = (await rows(env.DB.prepare('SELECT * FROM pilot_connections WHERE family_id = ? AND provider = ?')
    .bind(member.family_id, provider)))[0];
  if (existing && ['queued', 'discovering'].includes(existing.status)) return reply(409, { status: 'discovery_in_progress' });
  if (existing && now - Date.parse(existing.submitted_at) < 60000) return reply(429, { status: 'try_again_later' });
  const connection = { id: existing?.id ?? crypto.randomUUID(), family_id: member.family_id, provider, revision: crypto.randomUUID() };
  const encrypted = await sealCredentials({ username, password: input.password }, connection, env.CONNECTION_KEY);
  input.password = ''; input.username = '';
  const timestamp = iso(now); const jobId = crypto.randomUUID();
  // The conditional UPSERT decides races. The following job insert succeeds
  // only for the winning revision; all changes are in the same D1 transaction.
  const changes = await env.DB.batch([
    env.DB.prepare(`INSERT INTO pilot_connections (id, family_id, provider, revision, credentials, status, submitted_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 'queued', ?, ? FROM pilot_families WHERE id = ? AND revoked_at IS NULL
      ON CONFLICT(family_id, provider) DO UPDATE SET revision = excluded.revision, credentials = excluded.credentials,
        status = 'queued', reason = NULL, submitted_at = excluded.submitted_at, updated_at = excluded.updated_at
      WHERE pilot_connections.status NOT IN ('queued', 'discovering') AND pilot_connections.submitted_at <= ?
        AND pilot_connections.revision = ?`)
      .bind(connection.id, member.family_id, provider, connection.revision, encrypted, timestamp, timestamp, member.family_id, iso(now - 60000), existing?.revision ?? ''),
    env.DB.prepare(`INSERT INTO pilot_discovery_jobs (id, connection_id, revision, state, created_at, expires_at)
      SELECT ?, id, revision, 'queued', ?, ? FROM pilot_connections WHERE id = ? AND revision = ?`)
      .bind(jobId, timestamp, iso(now + 300000), connection.id, connection.revision),
  ]);
  const won = (await rows(env.DB.prepare('SELECT id FROM pilot_discovery_jobs WHERE id = ?').bind(jobId))).length;
  if (!changes || !won) return reply(409, { status: 'discovery_in_progress' });
  return reply(202, { status: 'queued' });
}

export async function disconnectConnection(env, member, provider, now) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO pilot_connections (id, family_id, provider, revision, credentials, status, submitted_at, updated_at)
      SELECT ?, ?, ?, ?, NULL, 'disconnected', ?, ? FROM pilot_families WHERE id = ? AND revoked_at IS NULL
      ON CONFLICT(family_id, provider) DO UPDATE SET revision = excluded.revision, credentials = NULL,
        status = 'disconnected', reason = NULL, updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), member.family_id, provider, crypto.randomUUID(), iso(now - 60000), iso(now), member.family_id),
    env.DB.prepare(`UPDATE pilot_discovery_jobs SET state = 'cancelled' WHERE connection_id IN
      (SELECT id FROM pilot_connections WHERE family_id = ? AND provider = ?)`).bind(member.family_id, provider),
    env.DB.prepare(`DELETE FROM pilot_candidates WHERE connection_id IN
      (SELECT id FROM pilot_connections WHERE family_id = ? AND provider = ?)`).bind(member.family_id, provider),
    env.DB.prepare("DELETE FROM pilot_child_providers WHERE family_id = ? AND provider = ?").bind(member.family_id, provider),
  ]);
  return reply(200, { status: 'disconnected' });
}

export async function confirmCandidate(env, member, provider, input) {
  const candidate = (await rows(env.DB.prepare(`SELECT k.* FROM pilot_candidates k JOIN pilot_connections c ON c.id = k.connection_id
    WHERE k.id = ? AND c.family_id = ? AND c.provider = ? AND c.status = 'ready' AND c.revision = k.revision`)
    .bind(typeof input.candidateId === 'string' ? input.candidateId : '', member.family_id, provider)))[0];
  if (!candidate) return reply(404, { status: 'child_not_found' });
  if (input.childId && !(await rows(env.DB.prepare('SELECT id FROM pilot_children WHERE family_id = ? AND id = ?')
    .bind(member.family_id, input.childId))).length) return reply(404, { status: 'child_not_found' });
  const linked = (await rows(env.DB.prepare(`SELECT child_id FROM pilot_child_providers
    WHERE connection_id = ? AND revision = ? AND remote_id = ?`).bind(candidate.connection_id, candidate.revision, candidate.remote_id)))[0];
  if (linked) return reply(200, { status: 'linked', childId: linked.child_id });
  const childId = input.childId || crypto.randomUUID();
  const existingMapping = (await rows(env.DB.prepare(`SELECT connection_id, remote_id, mapping FROM pilot_child_providers
    WHERE family_id = ? AND child_id = ? AND provider = ?`).bind(member.family_id, childId, provider)))[0];
  const identityField = provider === 'source' ? 'studentHeading' : 'banner';
  if (existingMapping && (existingMapping.connection_id !== candidate.connection_id || existingMapping.remote_id !== candidate.remote_id
      || JSON.parse(existingMapping.mapping)[identityField] !== JSON.parse(candidate.mapping)[identityField])) {
    return reply(409, { status: 'child_provider_conflict' });
  }
  // Every insert rechecks the current connection revision, so disconnect or
  // reconnect while the parent confirms cannot revive an old mapping.
  const guard = `SELECT k.id FROM pilot_candidates k JOIN pilot_connections c ON c.id = k.connection_id
    JOIN pilot_families f ON f.id = c.family_id WHERE k.id = ? AND c.family_id = ? AND c.provider = ?
      AND c.status = 'ready' AND c.revision = k.revision AND f.revoked_at IS NULL`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO pilot_children (family_id, id, display_name)
      SELECT ?, ?, ? WHERE EXISTS (${guard})`).bind(member.family_id, childId, candidate.display_name, candidate.id, member.family_id, provider),
    env.DB.prepare(`INSERT INTO pilot_child_providers (family_id, child_id, provider, connection_id, revision, remote_id, mapping)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})
      ON CONFLICT(family_id, child_id, provider) DO UPDATE SET connection_id = excluded.connection_id,
        revision = excluded.revision, remote_id = excluded.remote_id, mapping = excluded.mapping
      WHERE pilot_child_providers.connection_id = excluded.connection_id AND pilot_child_providers.remote_id = excluded.remote_id
        AND COALESCE(json_extract(pilot_child_providers.mapping, '$.studentHeading'), json_extract(pilot_child_providers.mapping, '$.banner'))
          = COALESCE(json_extract(excluded.mapping, '$.studentHeading'), json_extract(excluded.mapping, '$.banner'))`)
      .bind(member.family_id, childId, provider, candidate.connection_id, candidate.revision, candidate.remote_id, candidate.mapping,
        candidate.id, member.family_id, provider),
  ]);
  const saved = (await rows(env.DB.prepare(`SELECT child_id FROM pilot_child_providers WHERE family_id = ? AND child_id = ? AND provider = ?
    AND connection_id = ? AND revision = ? AND remote_id = ?`)
    .bind(member.family_id, childId, provider, candidate.connection_id, candidate.revision, candidate.remote_id)))[0];
  return saved ? reply(200, { status: 'linked', childId }) : reply(409, { status: 'selection_conflict' });
}

export async function claimDiscovery(env, provider, now = Date.now()) {
  if (!connectionAvailable(env, provider)) return null;
  await expireJobs(env, now);
  const lease = randomToken(); const leaseHash = await digest(lease);
  const claimed = await rows(env.DB.prepare(`UPDATE pilot_discovery_jobs SET state = 'running', lease_hash = ?, lease_expires_at = ?
    WHERE id = (SELECT j.id FROM pilot_discovery_jobs j JOIN pilot_connections c ON c.id = j.connection_id
      JOIN pilot_families f ON f.id = c.family_id WHERE j.state = 'queued' AND j.expires_at >= ?
      AND c.provider = ? AND c.revision = j.revision AND c.status = 'queued' AND f.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM pilot_check_jobs busy WHERE busy.connection_id = c.id
        AND busy.state = 'running' AND busy.lease_expires_at > ?)
      ORDER BY j.created_at, j.id LIMIT 1) AND state = 'queued' RETURNING id, connection_id, revision`)
    .bind(leaseHash, iso(now + 120000), iso(now + 120000), provider, iso(now)));
  if (!claimed.length) return null;
  const job = claimed[0];
  const connection = (await rows(env.DB.prepare(`SELECT c.* FROM pilot_connections c JOIN pilot_families f ON f.id = c.family_id
    WHERE c.id = ? AND c.revision = ? AND f.revoked_at IS NULL`).bind(job.connection_id, job.revision)))[0];
  if (!connection) return null;
  await env.DB.prepare("UPDATE pilot_connections SET status = 'discovering', updated_at = ? WHERE id = ? AND revision = ?")
    .bind(iso(now), connection.id, connection.revision).run();
  return { id: job.id, lease, provider, expiresAt: iso(now + 120000),
    credentials: await openCredentials(connection.credentials, connection, env.CONNECTION_KEY) };
}

function validateChildren(provider, children) {
  if (!Array.isArray(children) || !children.length || children.length > 20) return false;
  const ids = new Set(); const identities = new Set();
  return children.every(child => {
    if (typeof child.remoteId !== 'string' || !child.remoteId || child.remoteId.length > 200 || ids.has(child.remoteId)
      || typeof child.displayName !== 'string' || child.displayName.length > 150) return false;
    ids.add(child.remoteId);
    try { configuredChild({ defaultChild: 'candidate', children: [{ id: 'candidate', displayName: child.displayName, providers: { [provider]: child.mapping } }] }); }
    catch { return false; }
    const identity = provider === 'source' ? child.mapping.studentHeading : child.mapping.banner;
    const expectedName = provider === 'schoology' ? identity.replace(/^You are viewing as /, '')
      : identity.includes(',') ? `${identity.slice(identity.indexOf(',') + 1).trim()} ${identity.slice(0, identity.indexOf(',')).trim()}` : null;
    if (expectedName !== child.displayName) return false;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function cleanMapping(provider, mapping) {
  const fields = provider === 'source' ? ['tabLabel', 'tabHref', 'tabId', 'tabSwitchId', 'studentHeading'] : ['banner', 'selectionHref'];
  return Object.fromEntries(fields.filter(key => mapping[key] !== undefined).map(key => [key, mapping[key]]));
}

export async function completeDiscovery(env, provider, jobId, lease, output, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(lease ?? '')) return false;
  const job = (await rows(env.DB.prepare(`SELECT j.*, c.family_id FROM pilot_discovery_jobs j
    JOIN pilot_connections c ON c.id = j.connection_id JOIN pilot_families f ON f.id = c.family_id
    WHERE j.id = ? AND j.state = 'running' AND j.lease_hash = ? AND j.lease_expires_at > ? AND j.expires_at > ?
      AND c.provider = ? AND c.revision = j.revision AND c.status = 'discovering' AND f.revoked_at IS NULL`)
    .bind(jobId, await digest(lease), iso(now), iso(now), provider)))[0];
  if (!job) return false;
  const ok = output.status === 'ok' && validateChildren(provider, output.children);
  const reason = !ok && /^[a-z_]{1,64}$/.test(output.reason ?? '') ? output.reason : 'discovery_unverified';
  const guard = `SELECT j.id FROM pilot_discovery_jobs j JOIN pilot_connections c ON c.id = j.connection_id
    JOIN pilot_families f ON f.id = c.family_id WHERE j.id = ? AND j.state = 'running' AND j.lease_hash = ?
      AND j.lease_expires_at > ? AND j.expires_at > ? AND c.revision = j.revision AND c.status = 'discovering' AND f.revoked_at IS NULL`;
  const params = [jobId, await digest(lease), iso(now), iso(now)];
  const statements = [];
  if (ok) for (const child of output.children) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO pilot_candidates
    (id, connection_id, revision, remote_id, display_name, mapping) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})`)
    .bind(crypto.randomUUID(), job.connection_id, job.revision, child.remoteId, child.displayName, JSON.stringify(cleanMapping(provider, child.mapping)), ...params));
  statements.push(env.DB.prepare(`UPDATE pilot_connections SET status = ?, reason = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND EXISTS (${guard})`).bind(ok ? 'ready' : 'attention', ok ? null : reason, iso(now), job.connection_id, job.revision, ...params));
  // This runs last: stale leases cannot write candidates or connection status.
  statements.push(env.DB.prepare(`UPDATE pilot_discovery_jobs SET state = 'done' WHERE id = ? AND state = 'running'
    AND lease_hash = ? AND lease_expires_at > ? AND expires_at > ?
    AND EXISTS (SELECT 1 FROM pilot_connections c JOIN pilot_families f ON f.id = c.family_id
      WHERE c.id = pilot_discovery_jobs.connection_id AND c.revision = pilot_discovery_jobs.revision
        AND c.status IN ('ready', 'attention') AND c.updated_at = ? AND f.revoked_at IS NULL)`)
    .bind(...params, iso(now)));
  await env.DB.batch(statements);
  return (await rows(env.DB.prepare("SELECT id FROM pilot_discovery_jobs WHERE id = ? AND state = 'done' AND lease_hash = ?")
    .bind(jobId, params[1]))).length === 1;
}

export async function handleDiscoveryRunner(request, env, provider, action, readBody, now = Date.now()) {
  if (new URL(request.url).protocol !== 'https:' || new URL(request.url).origin !== env.APP_ORIGIN) return reply(404, { status: 'not_found' });
  if (!providers.includes(provider) || !await authorized(request, env[tokenName(provider)])) return reply(404, { status: 'not_found' });
  if (request.method !== 'POST') return reply(405, { status: 'method_not_allowed' });
  try {
  if (action === 'claim') {
    const job = await claimDiscovery(env, provider, now);
    return job ? reply(200, { status: 'claimed', job }) : reply(200, { status: 'idle' });
  }
  if (action === 'complete') {
    const input = await readBody(request);
    const accepted = await completeDiscovery(env, provider, input.jobId, input.lease, input.output ?? {}, now);
    return reply(accepted ? 200 : 409, { status: accepted ? 'recorded' : 'stale_job' });
  }
  return reply(404, { status: 'not_found' });
  } catch { return reply(503, { status: 'runner_unavailable' }); }
}
