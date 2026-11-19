import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { sealCredentials } from '../src/cloudflare/connection-crypto.js';
import { enqueueHostedChecks, claimHostedCheck, completeHostedCheck, handleHostedRunner } from '../src/cloudflare/hosted-checks.js';
import { dailyCheckSlot, skippedCheckDates, checkDayWindow } from '../src/cloudflare/check-schedule.js';
import { disconnectConnection, submitConnection, claimDiscovery } from '../src/cloudflare/connections.js';
import { runHostedSource } from '../scripts/source-runner/hosted.js';
import { runHostedSchedule } from '../src/cloudflare/hosted-schedule.js';

const now = Date.parse('2026-11-19T01:00:00Z'); // Wednesday 5 p.m. Seattle.
async function environment() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
  for (const name of ['0001_provider_checks.sql', '0002_pilot_families.sql', '0003_connections.sql', '0004_hosted_checks.sql', '0005_check_attempts.sql']) {
    sqlite.exec(await readFile(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const statement = (sql, values = []) => ({ bind: (...args) => statement(sql, args),
    all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...values)) });
  const env = { sqlite, APP_ORIGIN: 'https://pilot.example', HOSTED_CHECKS_ENABLED: 'true', HOSTED_CHECK_SKIP_DATES: '[]',
    SOURCE_CONNECTIONS_ENABLED: 'true', SCHOOLOGY_CONNECTIONS_ENABLED: 'true', BROWSER: {}, CONNECTION_KEY: 'a'.repeat(64),
    SOURCE_DISCOVERY_TOKEN: 'b'.repeat(64), SCHOOLOGY_DISCOVERY_TOKEN: 'c'.repeat(64),
    DB: { prepare: sql => statement(sql), batch: async statements => {
      sqlite.exec('BEGIN');
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } } };
  for (const family of ['one', 'two']) {
    sqlite.prepare('INSERT INTO pilot_families VALUES (?, ?, NULL)').run(family, new Date(now).toISOString());
    for (const child of ['first', 'second']) sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(family, child, `Alex ${child}`);
    for (const provider of ['source', 'schoology']) {
      const connection = { id: `${family}-${provider}`, revision: 'revision', family_id: family, provider };
      const credentials = await sealCredentials({ username: `${family}@example.com`, password: 'synthetic-password' }, connection, env.CONNECTION_KEY);
      sqlite.prepare("INSERT INTO pilot_connections VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?, ?)")
        .run(connection.id, family, provider, connection.revision, credentials, new Date(now).toISOString(), new Date(now).toISOString());
      for (const child of ['first', 'second']) {
        const mapping = provider === 'source' ? { tabLabel: 'Alex', studentHeading: `${child}, Alex`, tabSwitchId: child === 'first' ? '1' : '2' }
          : { banner: `You are viewing as Alex ${child}`, selectionHref: `/parent/switch_child/${child === 'first' ? '1' : '2'}` };
        sqlite.prepare('INSERT INTO pilot_child_providers VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(family, child, provider, connection.id, connection.revision, child, JSON.stringify(mapping));
      }
    }
  }
  return env;
}
function output(job, time = now + 1000) {
  return { status: 'ok', results: job.children.map(child => ({ childId: child.id, status: 'ok', observation: {
    version: 1, childId: child.id, provider: job.provider, observedAt: new Date(time).toISOString(),
    ...(job.provider === 'source' ? { term: null, courses: [{ course: 'French', semester: 'B', missing: null, rows: null }], attendance: { absences: [], tardies: [] } }
      : { overdue: null, upcoming: [], recentlyCompleted: [], events: [], overdueCoverage: 'unavailable' }),
  } })) };
}

test('Seattle weekday schedule handles daylight saving and explicit no-school dates', () => {
  assert.equal(dailyCheckSlot(Date.parse('2026-11-19T00:59:59Z')), null);
  assert.equal(dailyCheckSlot(now), '2026-11-18');
  assert.equal(dailyCheckSlot(Date.parse('2026-07-16T00:00:00Z')), '2026-07-15');
  assert.equal(dailyCheckSlot(Date.parse('2026-11-22T01:00:00Z')), null);
  assert.equal(dailyCheckSlot(now, ['2026-11-18']), null);
  assert.throws(() => skippedCheckDates('["not-a-date"]'));
});

test('two families and two children stay isolated; daily scheduling and completion are idempotent', async () => {
  const env = await environment();
  await Promise.all([enqueueHostedChecks(env, now), enqueueHostedChecks(env, now)]);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_check_jobs').get().n, 4);
  const job = await claimHostedCheck(env, 'source', now);
  assert.equal(job.children.length, 2);
  const another = await claimHostedCheck(env, 'source', now);
  assert.notEqual(job.credentials.username, another.credentials.username);
  assert.equal(await claimHostedCheck(env, 'source', now), null);
  assert.equal(await completeHostedCheck(env, 'schoology', job.id, job.lease, output(job), now + 2000), false);
  assert.equal(await completeHostedCheck(env, 'source', job.id, 'd'.repeat(64), output(job), now + 2000), false);
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000), true);
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000), false);
  const saved = env.sqlite.prepare('SELECT * FROM provider_checks').all();
  assert.equal(saved.length, 2);
  assert.equal(new Set(saved.map(row => row.family_id)).size, 1);
  assert.equal(JSON.parse(saved[0].observation).courses[0].missing, null);
  await enqueueHostedChecks(env, now + 60000);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_check_jobs').get().n, 4);
});

test('initial check follows confirmation, with no weekend polling or empty-family sign-ins', async () => {
  const env = await environment(); const weekend = Date.parse('2026-11-21T20:00:00Z');
  env.sqlite.prepare("DELETE FROM pilot_child_providers WHERE family_id = 'two'").run();
  await enqueueHostedChecks(env, weekend);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_check_jobs').get().n, 2);
  const job = await claimHostedCheck(env, 'source', weekend);
  await completeHostedCheck(env, 'source', job.id, job.lease, output(job, weekend + 1000), weekend + 2000);
  await enqueueHostedChecks(env, weekend + 60000);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_check_jobs').get().n, 2);
});

test('disconnect, reconnect, revocation and changed mappings reject stale writes', async () => {
  for (const change of ['disconnect', 'reconnect', 'revoke', 'mapping']) {
    const env = await environment(); await enqueueHostedChecks(env, now);
    const job = await claimHostedCheck(env, 'source', now);
    const family = env.sqlite.prepare('SELECT family_id FROM pilot_connections WHERE id = (SELECT connection_id FROM pilot_check_jobs WHERE id = ?)').get(job.id).family_id;
    if (change === 'disconnect') await disconnectConnection(env, { family_id: family }, 'source', now + 500);
    if (change === 'reconnect') env.sqlite.prepare("UPDATE pilot_connections SET revision = 'new' WHERE family_id = ? AND provider = 'source'").run(family);
    if (change === 'revoke') env.sqlite.prepare('UPDATE pilot_families SET revoked_at = ? WHERE id = ?').run(new Date(now).toISOString(), family);
    if (change === 'mapping') env.sqlite.prepare("UPDATE pilot_child_providers SET mapping = '{}' WHERE family_id = ? AND provider = 'source'").run(family);
    await completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000);
    assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM provider_checks').get().n, 0, change);
  }
});

test('incomplete or mismatched results cannot clear work; timeouts retain prior verified records', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'source', now);
  const malformed = output(job); malformed.results.pop();
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, malformed, now + 2000), false);
  const future = output(job, now + 10000);
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, future, now + 2000), false);
  const other = output(job); other.results[0].childId = 'outsider';
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, other, now + 2000), false);
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000), true);
  await enqueueHostedChecks(env, now + 86400000);
  // Expire the next day's running lease; the next poll records an unavailable attempt.
  const next = await claimHostedCheck(env, 'source', now + 86400000);
  assert.ok(next);
  await claimHostedCheck(env, 'source', now + 86400000 + 301000);
  const history = env.sqlite.prepare('SELECT status FROM provider_checks WHERE run_id IN (?, ?)').all(job.id, next.id);
  assert.equal(history.filter(row => row.status === 'ok').length, 2);
  assert.equal(history.filter(row => row.status === 'unavailable').length, 2);
});

test('credential challenges pause recurring sign-ins until the parent reconnects', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'schoology', now);
  await completeHostedCheck(env, 'schoology', job.id, job.lease, { status: 'unavailable', reason: 'schoology_credentials_rejected' }, now + 2000);
  const attention = env.sqlite.prepare("SELECT count(*) AS n FROM pilot_connections WHERE status = 'attention'").get().n;
  assert.equal(attention, 1);
  await enqueueHostedChecks(env, now + 86400000);
  const jobConnection = env.sqlite.prepare('SELECT connection_id FROM pilot_check_jobs WHERE id = ?').get(job.id).connection_id;
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_check_jobs WHERE connection_id = ?').get(jobConnection).n, 1);
});

test('collection endpoint uses provider-scoped auth and the Source transport refuses redirects', async () => {
  const env = await environment();
  const request = new Request('https://pilot.example/v1/collection/source/claim', { method: 'POST', headers: { Authorization: `Bearer ${env.SCHOOLOGY_DISCOVERY_TOKEN}` } });
  assert.equal((await handleHostedRunner(request, env, 'claim', () => Promise.resolve({}), now)).status, 404);
  const fake = { id: crypto.randomUUID(), provider: 'source', lease: 'd'.repeat(64), children: [{ id: 'first' }],
    expiresAt: new Date(Date.now() + 300000).toISOString(), credentials: { username: 'parent@example.com', password: 'synthetic' } };
  let collected = false; let claimedCredentials = null;
  const result = await runHostedSource({ origin: 'https://pilot.example', token: 'b'.repeat(64), discover: () => Promise.resolve({ status: 'idle' }),
    collect: (provider, credentials, children) => { collected = true; claimedCredentials = credentials; assert.equal(provider, 'source'); assert.equal(children.length, 1); return Promise.resolve({ status: 'ok', results: [] }); },
    request: (url, options) => { assert.equal(options.redirect, 'error'); return Promise.resolve(Response.json(url.endsWith('/claim') ? { status: 'claimed', job: fake } : { status: 'recorded' })); } });
  assert.equal(result.status, 'recorded'); assert.equal(collected, true); assert.equal(claimedCredentials.password, '');
});

test('scheduled Schoology consumer stores observations without returning credentials or student records', async () => {
  const env = await environment();
  const status = await runHostedSchedule(env, { discover: () => Promise.resolve({ status: 'idle' }), collect: (provider, credentials, children) => {
    assert.equal(provider, 'schoology');
    return Promise.resolve(output({ provider, children }, Date.now()));
  } });
  assert.deepEqual(status, { status: 'recorded' });
  assert.equal(env.sqlite.prepare("SELECT count(*) AS n FROM provider_checks WHERE provider = 'schoology'").get().n, 2);
});


test('reconnect waits for the older browser to close and keeps a full discovery window', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'source', now);
  const connection = env.sqlite.prepare('SELECT c.* FROM pilot_connections c JOIN pilot_check_jobs j ON j.connection_id=c.id WHERE j.id=?').get(job.id);
  const reconnectedAt = now + 61000;
  const response = await submitConnection(env, { family_id: connection.family_id }, 'source',
    { username: 'parent@example.com', password: 'replacement' }, reconnectedAt);
  assert.equal(response.status, 202);
  assert.equal(await claimDiscovery(env, 'source', reconnectedAt), null, 'old browser still owns the connection');
  await claimHostedCheck(env, 'source', reconnectedAt);
  assert.equal(env.sqlite.prepare('SELECT state FROM pilot_check_jobs WHERE id = ?').get(job.id).state, 'running');
  const finishedAt = now + 241000;
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, output(job, finishedAt - 1000), finishedAt), false);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM provider_checks WHERE run_id = ?').get(job.id).n, 0);
  assert.equal(env.sqlite.prepare('SELECT state FROM pilot_check_jobs WHERE id = ?').get(job.id).state, 'cancelled');
  assert.ok(await claimDiscovery(env, 'source', finishedAt), 'reconnect still has its full discovery lease available');
});

test('adding a confirmed child rejects the older mapping-set result without pausing the connection', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'source', now);
  const connection = env.sqlite.prepare('SELECT c.* FROM pilot_connections c JOIN pilot_check_jobs j ON j.connection_id=c.id WHERE j.id=?').get(job.id);
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(connection.family_id, 'third', 'Alex Third');
  env.sqlite.prepare('INSERT INTO pilot_child_providers VALUES (?, ?, ?, ?, ?, ?, ?)').run(connection.family_id, 'third', 'source', connection.id, connection.revision,
    'third', JSON.stringify({ tabLabel: 'Alex', studentHeading: 'Third, Alex', tabSwitchId: '3' }));
  assert.equal(await completeHostedCheck(env, 'source', job.id, job.lease, { status: 'unavailable', reason: 'sign_in_needs_attention' }, now + 1000), false);
  assert.equal(env.sqlite.prepare('SELECT status FROM pilot_connections WHERE id=?').get(connection.id).status, 'ready');
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM provider_checks WHERE run_id=?').get(job.id).n, 0);
});

test('initial attempts near five do not trigger another same-day password attempt', async () => {
  const env = await environment(); const early = now - 1000;
  await enqueueHostedChecks(env, early); const job = await claimHostedCheck(env, 'source', early);
  await enqueueHostedChecks(env, now);
  await completeHostedCheck(env, 'source', job.id, job.lease, { status: 'unavailable', reason: 'check_failed' }, now + 1000);
  await enqueueHostedChecks(env, now + 2000);
  // Only the other family's independent Source job may still be claimed.
  const otherFamily = await claimHostedCheck(env, 'source', now + 2000);
  assert.notEqual(otherFamily.credentials.username, job.credentials.username);
  assert.equal(await claimHostedCheck(env, 'source', now + 2000), null);
});

test('expired slots that never attempted sign-in are renewed on a later poll', async () => {
  const env = await environment(); const weekend = Date.parse('2026-11-21T20:00:00Z');
  await enqueueHostedChecks(env, weekend);
  await enqueueHostedChecks(env, weekend + 3600001);
  const jobs = env.sqlite.prepare('SELECT * FROM pilot_check_jobs').all();
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every(job => Date.parse(job.expires_at) > weekend + 3600001));
  assert.ok(await claimHostedCheck(env, 'source', weekend + 3600001));
});

test('malformed nested school entries cannot become verified observations', async () => {
  for (const provider of ['source', 'schoology']) {
    const env = await environment(); await enqueueHostedChecks(env, now);
    const job = await claimHostedCheck(env, provider, now); const bad = output(job);
    if (provider === 'source') bad.results[0].observation.courses[0].missing = [null];
    else bad.results[0].observation.upcoming = [{ course: 'French', url: 'not a URL' }];
    assert.equal(await completeHostedCheck(env, provider, job.id, job.lease, bad, now + 2000), false);
    assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM provider_checks').get().n, 0);
  }
});

test('infrastructure and collection-layout failures remain unavailable without disabling sign-in', async () => {
  for (const reason of ['check_failed', 'discovery_failed', 'source_layout_changed']) {
    const env = await environment(); await enqueueHostedChecks(env, now);
    const job = await claimHostedCheck(env, 'source', now);
    await completeHostedCheck(env, 'source', job.id, job.lease, { status: 'unavailable', reason }, now + 2000);
    assert.equal(env.sqlite.prepare("SELECT count(*) AS n FROM pilot_connections WHERE status='attention'").get().n, 0);
  }
});

test('a concurrent duplicate completion cannot report a second accepted write', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'source', now);
  const accepted = await Promise.all([completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000),
    completeHostedCheck(env, 'source', job.id, job.lease, output(job), now + 2000)]);
  assert.deepEqual(accepted.sort(), [false, true]);
});

test('completion uses the clock after reading its body', async () => {
  const env = await environment(); await enqueueHostedChecks(env, now);
  const job = await claimHostedCheck(env, 'source', now);
  let clock = now + 1000;
  const request = new Request('https://pilot.example/v1/collection/source/complete', { method: 'POST',
    headers: { Authorization: `Bearer ${env.SOURCE_DISCOVERY_TOKEN}` } });
  const response = await handleHostedRunner(request, env, 'complete', () => {
    clock = now + 301000; return Promise.resolve({ jobId: job.id, lease: job.lease, output: output(job) });
  }, () => clock);
  assert.equal(response.status, 409);
});


test('attempt-day boundaries include the 23- and 25-hour Seattle days', () => {
  const spring = checkDayWindow(Date.parse('2026-03-08T18:00:00Z'));
  const autumn = checkDayWindow(Date.parse('2026-11-01T18:00:00Z'));
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600000);
});
