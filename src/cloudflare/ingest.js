// Receives Source results pushed by the hosted runner and stores them in D1.
// Nothing here logs request bodies, student records or tokens.
const maxBodyBytes = 512 * 1024;
const idPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const reasonPattern = /^[a-z_]{1,64}$/;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = { 'Cache-Control': 'no-store' };

const reply = (status, body) => Response.json(body, { status, headers });
const notFound = () => new Response(null, { status: 404, headers });

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Comparing digests keeps the comparison time independent of the token.
// An unauthorized caller cannot tell a wrong token from a missing route.
export async function authorized(request, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const [supplied, expected] = await Promise.all([
    sha256(request.headers.get('Authorization') ?? ''), sha256(`Bearer ${token}`)]);
  return supplied === expected;
}

export function allowedChildren(env) {
  const ids = String(env.CHILD_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  return ids.length > 0 && ids.every(id => idPattern.test(id)) && idPattern.test(env.FAMILY_ID ?? '')
    ? new Set(ids) : null;
}

function validObservation(observation, childId) {
  return observation?.version === 1 && observation.provider === 'source' && observation.childId === childId &&
    Number.isFinite(Date.parse(observation.observedAt)) &&
    Array.isArray(observation.courses) && observation.courses.length > 0 &&
    observation.courses.every(course => typeof course?.course === 'string' &&
      (course.missing === null || Array.isArray(course.missing))) &&
    Array.isArray(observation.attendance?.absences) && Array.isArray(observation.attendance?.tardies);
}

function validRun(run, now) {
  const attempted = Date.parse(run?.attemptedAt);
  return run?.version === 1 && runIdPattern.test(run.runId ?? '') && idPattern.test(run.runner ?? '') &&
    Number.isFinite(attempted) && attempted <= now + 5 * 60000 && attempted >= now - 24 * 3600000 &&
    Array.isArray(run.results) && run.results.length > 0;
}

// Returns one row to store, or null when the result is invalid.
function parseResult(result, attempted, now) {
  const row = { childId: result.childId, status: result.status, reason: null, observedAt: null, observation: null };
  if (result.status === 'unavailable') {
    if (!reasonPattern.test(result.reason ?? '')) return null;
    return { ...row, reason: result.reason };
  }
  if (result.status !== 'ok' || !validObservation(result.observation, result.childId)) return null;
  const observed = Date.parse(result.observation.observedAt);
  if (observed < attempted - 60000 || observed > now + 5 * 60000) return null;
  return { ...row, observedAt: new Date(observed).toISOString(), observation: JSON.stringify(result.observation) };
}

// Returns the rows to store, or null when any part of the run is invalid.
export function parseSourceRun(run, children, now) {
  if (!validRun(run, now) || run.results.length > children.size) return null;
  const attempted = Date.parse(run.attemptedAt);
  const seen = new Set();
  const rows = [];
  for (const result of run.results) {
    if (result?.provider !== 'source' || !children.has(result.childId) || seen.has(result.childId)) return null;
    seen.add(result.childId);
    const row = parseResult(result, attempted, now);
    if (!row) return null;
    rows.push(row);
  }
  return { runId: run.runId, runner: run.runner, attemptedAt: new Date(attempted).toISOString(), rows };
}

export async function handleSourceIngest(request, env, now = Date.now()) {
  if (!await authorized(request, env.INGEST_TOKEN)) return notFound();
  const children = allowedChildren(env);
  if (!children || !env.DB) return reply(503, { status: 'not_configured' });
  if (Number(request.headers.get('Content-Length') ?? 0) > maxBodyBytes) return reply(413, { status: 'invalid_request' });
  const body = await request.text();
  if (body.length > maxBodyBytes) return reply(413, { status: 'invalid_request' });
  let run = null;
  try { run = parseSourceRun(JSON.parse(body), children, now); } catch { /* Reported as invalid below. */ }
  if (!run) return reply(400, { status: 'invalid_request' });

  // A repeated delivery of the same run stores nothing new.
  const insert = env.DB.prepare(`INSERT OR IGNORE INTO provider_checks
    (run_id, family_id, child_id, provider, runner, status, reason, attempted_at, observed_at, observation, received_at)
    VALUES (?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, ?)`);
  const receivedAt = new Date(now).toISOString();
  await env.DB.batch(run.rows.map(row => insert.bind(run.runId, env.FAMILY_ID, row.childId, run.runner,
    row.status, row.reason, run.attemptedAt, row.observedAt, row.observation, receivedAt)));
  return reply(200, { status: 'stored', results: run.rows.length });
}

// Reports when each provider was last attempted and last verified.
// It returns no student records.
export async function handleLatestChecks(request, env) {
  if (!await authorized(request, env.STATUS_TOKEN)) return notFound();
  if (!allowedChildren(env) || !env.DB) return reply(503, { status: 'not_configured' });
  const { results } = await env.DB.prepare(`SELECT child_id, provider, status, reason, attempted_at, observed_at
    FROM provider_checks WHERE family_id = ? ORDER BY attempted_at DESC LIMIT 500`).bind(env.FAMILY_ID).all();
  const latest = new Map();
  for (const row of results) {
    const key = `${row.child_id}/${row.provider}`;
    if (!latest.has(key)) {
      latest.set(key, { childId: row.child_id, provider: row.provider, lastAttemptAt: row.attempted_at,
        lastStatus: row.status, lastReason: row.reason, lastVerifiedAt: null });
    }
    const entry = latest.get(key);
    if (row.status === 'ok' && !entry.lastVerifiedAt) entry.lastVerifiedAt = row.observed_at;
  }
  return reply(200, { status: 'ok', checks: [...latest.values()] });
}
