import { authorized } from './ingest.js';
import { connectionAvailable } from './connections.js';
import { digest, randomToken, openCredentials } from './connection-crypto.js';
import { dailyCheckSlot, skippedCheckDates } from './check-schedule.js';
import { configuredChild } from '../core/children.js';

const rows = async statement => (await statement.all()).results;
const iso = now => new Date(now).toISOString();
const leaseMs = 300000;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

function confirmedChildren(provider, mappings) {
  const children = mappings.map(mapping => ({ id: mapping.child_id, displayName: mapping.display_name,
    providers: { [provider]: JSON.parse(mapping.mapping) } }));
  if (!children.length || children.length > 20) throw new Error('invalid_confirmed_children');
  const config = { defaultChild: children[0].id, children };
  for (const child of children) configuredChild(config, child.id);
  return children;
}

// The guard is evaluated again inside each write transaction. Disconnect,
// reconnect, revocation and changed mappings cannot revive an old result.
const liveGuard = `SELECT j.id FROM pilot_check_jobs j JOIN pilot_connections c ON c.id = j.connection_id
  JOIN pilot_families f ON f.id = c.family_id
  WHERE j.id = ? AND j.state = 'running' AND j.lease_hash = ? AND j.lease_expires_at > ?
    AND j.expires_at > ? AND c.revision = j.revision AND c.status = 'ready' AND f.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(j.children) expected LEFT JOIN pilot_child_providers p
      ON p.connection_id = c.id AND p.revision = c.revision AND p.child_id = json_extract(expected.value, '$.id')
      AND p.provider = c.provider AND p.family_id = c.family_id
      WHERE p.mapping IS NULL OR p.mapping != json_extract(expected.value, '$.providers.' || c.provider))`;

export async function enqueueHostedChecks(env, now = Date.now()) {
  if (env.HOSTED_CHECKS_ENABLED !== 'true') return;
  const daily = dailyCheckSlot(now, skippedCheckDates(env.HOSTED_CHECK_SKIP_DATES));
  const connections = await rows(env.DB.prepare(`SELECT c.id, c.revision, c.provider, c.family_id FROM pilot_connections c
    JOIN pilot_families f ON f.id = c.family_id WHERE c.status = 'ready' AND f.revoked_at IS NULL`));
  for (const connection of connections) {
    if (!connectionAvailable(env, connection.provider)) continue;
    const mappings = await rows(env.DB.prepare(`SELECT p.child_id, k.display_name, p.mapping FROM pilot_child_providers p
      JOIN pilot_children k ON k.family_id = p.family_id AND k.id = p.child_id
      WHERE p.connection_id = ? AND p.revision = ? ORDER BY p.child_id`).bind(connection.id, connection.revision));
    if (!mappings.length) continue;
    const children = JSON.stringify(confirmedChildren(connection.provider, mappings));
    // One initial read for each confirmed mapping set, then at most one per local weekday.
    // A successful daily job also satisfies initial collection for that mapping set.
    const fingerprint = await digest(children);
    const initial = `initial:${fingerprint}`;
    const slot = daily ? `${daily}:${fingerprint}` : initial;
    const previous = await rows(env.DB.prepare(`SELECT id FROM pilot_check_jobs
      WHERE connection_id = ? AND revision = ? AND (slot = ? OR children = ? AND state = 'done') LIMIT 1`)
      .bind(connection.id, connection.revision, initial, children));
    if (!daily && previous.length) continue;
    await env.DB.prepare(`INSERT OR IGNORE INTO pilot_check_jobs
      (id, connection_id, revision, slot, children, state, created_at, expires_at)
      SELECT ?, c.id, c.revision, ?, ?, 'queued', ?, ? FROM pilot_connections c
      JOIN pilot_families f ON f.id = c.family_id WHERE c.id = ? AND c.revision = ?
        AND c.status = 'ready' AND f.revoked_at IS NULL`)
      .bind(crypto.randomUUID(), slot, children, iso(now), iso(now + 3600000), connection.id, connection.revision).run();
  }
}

async function expireChecks(env, provider, now) {
  const expired = await rows(env.DB.prepare(`SELECT j.id, j.lease_hash FROM pilot_check_jobs j
    JOIN pilot_connections c ON c.id = j.connection_id WHERE c.provider = ? AND j.state = 'running'
      AND (j.lease_expires_at <= ? OR j.expires_at <= ?)`)
    .bind(provider, iso(now), iso(now)));
  for (const job of expired) await finishHostedCheck(env, provider, job.id, job.lease_hash,
    { status: 'unavailable', reason: 'check_expired' }, now, true);
  await env.DB.prepare(`UPDATE pilot_check_jobs SET state = 'cancelled' WHERE connection_id IN
    (SELECT id FROM pilot_connections WHERE provider = ?) AND ((state = 'queued' AND expires_at <= ?) OR (state = 'running' AND lease_expires_at <= ?)
    OR (state IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM pilot_connections c
      JOIN pilot_families f ON f.id = c.family_id WHERE c.id = pilot_check_jobs.connection_id
        AND c.revision = pilot_check_jobs.revision AND c.status = 'ready' AND f.revoked_at IS NULL)))`)
    .bind(provider, iso(now), iso(now)).run();
}

export async function claimHostedCheck(env, provider, now = Date.now()) {
  if (env.HOSTED_CHECKS_ENABLED !== 'true' || !connectionAvailable(env, provider)) return null;
  await expireChecks(env, provider, now);
  const lease = randomToken(); const leaseHash = await digest(lease);
  const claimed = await rows(env.DB.prepare(`UPDATE pilot_check_jobs SET state = 'running', lease_hash = ?, lease_expires_at = ?
    WHERE id = (SELECT j.id FROM pilot_check_jobs j JOIN pilot_connections c ON c.id = j.connection_id
      JOIN pilot_families f ON f.id = c.family_id WHERE j.state = 'queued' AND j.expires_at >= ?
      AND c.provider = ? AND c.revision = j.revision AND c.status = 'ready' AND f.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM pilot_check_jobs busy WHERE busy.connection_id = c.id AND busy.state = 'running')
      AND NOT EXISTS (SELECT 1 FROM pilot_discovery_jobs busy WHERE busy.connection_id = c.id AND busy.state = 'running')
      ORDER BY j.created_at, j.id LIMIT 1) AND state = 'queued' RETURNING *`)
    .bind(leaseHash, iso(now + leaseMs), iso(now + leaseMs), provider));
  if (!claimed.length) return null;
  const job = claimed[0];
  const connection = (await rows(env.DB.prepare(`SELECT c.* FROM pilot_connections c JOIN pilot_families f ON f.id = c.family_id
    WHERE c.id = ? AND c.revision = ? AND c.status = 'ready' AND f.revoked_at IS NULL`)
    .bind(job.connection_id, job.revision)))[0];
  if (!connection) return null;
  return { id: job.id, lease, provider, expiresAt: iso(now + leaseMs), children: JSON.parse(job.children),
    credentials: await openCredentials(connection.credentials, connection, env.CONNECTION_KEY) };
}

function validObservation(observation, child, provider, job, now) {
  if (observation?.version !== 1 || observation.provider !== provider || observation.childId !== child.id
      || !(Date.parse(observation.observedAt) >= Date.parse(job.created_at)) || !(Date.parse(observation.observedAt) <= now)) return false;
  if (provider === 'source') return Array.isArray(observation.courses) && observation.courses.length > 0
    && observation.courses.every(course => typeof course?.course === 'string' && (course.missing === null || Array.isArray(course.missing)))
    && Array.isArray(observation.attendance?.absences) && Array.isArray(observation.attendance?.tardies);
  return ['overdue', 'upcoming', 'events', 'recentlyCompleted'].every(field => observation[field] === null || Array.isArray(observation[field]));
}

function resultRows(output, children, provider, job, now) {
  if (output.status === 'unavailable' && /^[a-z_]{1,64}$/.test(output.reason ?? '')) {
    return children.map(child => ({ childId: child.id, status: 'unavailable', reason: output.reason }));
  }
  if (output.status !== 'ok' || !Array.isArray(output.results) || output.results.length !== children.length) return null;
  const seen = new Set();
  for (const result of output.results) {
    const child = children.find(value => value.id === result?.childId);
    if (!child || seen.has(child.id)) return null;
    seen.add(child.id);
    if (result.status === 'ok') {
      if (!validObservation(result.observation, child, provider, job, now)) return null;
    } else if (result.status !== 'unavailable' || !/^[a-z_]{1,64}$/.test(result.reason ?? '')) return null;
  }
  return output.results;
}

async function finishHostedCheck(env, provider, jobId, leaseHash, output, now, expired = false) {
  const job = (await rows(env.DB.prepare(`SELECT j.*, c.family_id FROM pilot_check_jobs j
    JOIN pilot_connections c ON c.id = j.connection_id WHERE j.id = ? AND c.provider = ? AND j.state = 'running' AND j.lease_hash = ?`)
    .bind(jobId, provider, leaseHash)))[0];
  if (!job) return false;
  const children = JSON.parse(job.children);
  const results = resultRows(output, children, provider, job, now);
  if (!results) return false;
  const guard = expired ? liveGuard.replace('j.lease_expires_at > ?', 'j.lease_expires_at <= ?').replace('AND j.expires_at > ?', 'AND ? IS NOT NULL') : liveGuard;
  const params = [jobId, leaseHash, iso(now), iso(now)];
  const statements = results.map(result => env.DB.prepare(`INSERT OR IGNORE INTO provider_checks
    (run_id, family_id, child_id, provider, runner, status, reason, attempted_at, observed_at, observation, received_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard})
      AND EXISTS (SELECT 1 FROM pilot_child_providers p WHERE p.family_id = ? AND p.child_id = ?
        AND p.provider = ? AND p.connection_id = ? AND p.revision = ? AND p.mapping = ?)`)
    .bind(jobId, job.family_id, result.childId, provider, provider === 'source' ? 'aws-us-west-2' : 'cloudflare-browser-run',
      result.status, result.status === 'ok' ? null : result.reason, job.created_at,
      result.status === 'ok' ? result.observation.observedAt : null, result.status === 'ok' ? JSON.stringify(result.observation) : null, iso(now),
      ...params, job.family_id, result.childId, provider, job.connection_id, job.revision,
      JSON.stringify(children.find(child => child.id === result.childId).providers[provider])));
  // Auth/identity challenges require a parent's explicit reconnect; never loop passwords.
  const needsAttention = results.some(result => result.status === 'unavailable' && !['check_failed', 'check_expired'].includes(result.reason));
  if (needsAttention) statements.push(env.DB.prepare(`UPDATE pilot_connections SET status = 'attention', reason = 'check_needs_attention', updated_at = ?
    WHERE id = ? AND EXISTS (${guard})`).bind(iso(now), job.connection_id, ...params));
  // Run after guarded writes, including an optional connection status change.
  const doneGuard = guard.replace("AND c.status = 'ready'", "AND c.status IN ('ready', 'attention')");
  statements.push(env.DB.prepare(`UPDATE pilot_check_jobs SET state = 'done' WHERE id = ? AND EXISTS (${doneGuard})`).bind(jobId, ...params));
  await env.DB.batch(statements);
  return Boolean((await rows(env.DB.prepare("SELECT id FROM pilot_check_jobs WHERE id = ? AND state = 'done'").bind(jobId))).length);
}

export async function completeHostedCheck(env, provider, jobId, lease, output, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(lease ?? '')) return false;
  return finishHostedCheck(env, provider, jobId, await digest(lease), output, now);
}

export async function handleHostedRunner(request, env, action, readBody, now = Date.now()) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.origin !== env.APP_ORIGIN || !await authorized(request, env.SOURCE_DISCOVERY_TOKEN)) return reply(404, { status: 'not_found' });
  if (request.method !== 'POST') return reply(405, { status: 'method_not_allowed' });
  try {
    if (action === 'claim') {
      const job = await claimHostedCheck(env, 'source', now);
      return reply(200, job ? { status: 'claimed', job } : { status: 'idle' });
    }
    const input = await readBody(request);
    const accepted = await completeHostedCheck(env, 'source', input.jobId, input.lease, input.output ?? {}, now);
    return reply(accepted ? 200 : 409, { status: accepted ? 'recorded' : 'stale_job' });
  } catch { return reply(503, { status: 'check_runner_unavailable' }); }
}
