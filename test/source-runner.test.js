import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CheckError } from '../src/auth.js';
import { handleLatestChecks, handleSourceIngest } from '../src/cloudflare/ingest.js';
import worker from '../src/cloudflare/worker.js';
import { credentialTag, decide, intervalMs, nextState } from '../scripts/source-runner/policy.js';
import { runSourceChecks, sourceChildren } from '../scripts/source-runner/run.js';

const ingestToken = 'a'.repeat(64);
const statusToken = 'b'.repeat(64);
const now = Date.parse('2026-11-12T01:00:00Z');
const hour = 3600000;
const children = [{ id: 'child-one' }, { id: 'child-two' }];
const credentials = { username: 'guardian', password: 'synthetic-password' };
const tag = credentialTag(ingestToken, credentials);
const observation = (childId, observedAt = new Date(now + 20000).toISOString()) => ({
  version: 1, provider: 'source', childId, observedAt, term: null,
  courses: [{ course: 'Sample course', period: '1', semester: 'A', missing: [], rows: [] },
    { course: 'Support', period: '2', semester: '', missing: null, rows: null }],
  attendance: { absences: [], tardies: [] },
});

// A D1-shaped wrapper over SQLite, loaded with the real migration.
async function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../worker/migrations/0001_provider_checks.sql', import.meta.url), 'utf8'));
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...values)),
    all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }),
  });
  return { sqlite, prepare: sql => statement(sql),
    batch: list => Promise.all(list.map(item => item.run())) };
}

async function environment() {
  return { DB: await database(), INGEST_TOKEN: ingestToken, STATUS_TOKEN: statusToken,
    FAMILY_ID: 'pilot-family', CHILD_IDS: 'child-one, child-two' };
}

const ingestRequest = (run, token = ingestToken) => new Request('https://checker.example/v1/ingest/source', {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: typeof run === 'string' ? run : JSON.stringify(run) });
const sourceRun = (results, attemptedAt = new Date(now).toISOString(), runId = crypto.randomUUID()) =>
  ({ version: 1, runId, runner: 'aws-us-west-2', attemptedAt, results });
const ok = childId => ({ childId, provider: 'source', status: 'ok', observation: observation(childId) });
const failed = (childId, reason) => ({ childId, provider: 'source', status: 'unavailable', reason });

async function latest(env) {
  const response = await handleLatestChecks(new Request('https://checker.example/v1/checks/latest',
    { headers: { Authorization: `Bearer ${statusToken}` } }), env);
  return Object.fromEntries((await response.json()).checks.map(check => [check.childId, check]));
}

function runnerHarness(env, overrides = {}) {
  const saved = [];
  const posts = [];
  const options = { children, credentials, tag, state: null, interval: 6 * hour, now,
    saveState: next => { saved.push(next); return Promise.resolve(); },
    post: async run => { posts.push(run); return (await handleSourceIngest(ingestRequest(run), env, now + 30000)).ok; },
    ...overrides };
  return { saved, posts, run: () => runSourceChecks(options) };
}

test('the runner signs in once and the Worker stores each child separately', async () => {
  const env = await environment();
  let reads = 0;
  const harness = runnerHarness(env, { read: (list, supplied) => {
    reads += 1;
    assert.deepEqual(supplied, credentials);
    return Promise.resolve([ok(list[0].id), failed(list[1].id, 'source_child_tab_unverified')]);
  } });
  assert.deepEqual(await harness.run(), { status: 'posted', results: [
    { childId: 'child-one', status: 'ok' },
    { childId: 'child-two', status: 'unavailable', reason: 'source_child_tab_unverified' }] });
  assert.equal(reads, 1);
  assert.equal(harness.saved.at(-1).hold, null);
  const checks = await latest(env);
  assert.equal(checks['child-one'].lastStatus, 'ok');
  assert.equal(checks['child-one'].lastVerifiedAt, new Date(now + 20000).toISOString());
  assert.deepEqual([checks['child-two'].lastStatus, checks['child-two'].lastReason, checks['child-two'].lastVerifiedAt],
    ['unavailable', 'source_child_tab_unverified', null]);

  // Delivering the same run again changes nothing.
  assert.equal((await handleSourceIngest(ingestRequest(harness.posts[0]), env, now + 60000)).status, 200);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM provider_checks').get().n, 2);
  const stored = JSON.parse(env.DB.sqlite.prepare("SELECT observation FROM provider_checks WHERE status = 'ok'").get().observation);
  assert.equal(stored.courses[1].missing, null);
});

test('a later failure never replaces the last verified observation', async () => {
  const env = await environment();
  await handleSourceIngest(ingestRequest(sourceRun([ok('child-one')])), env, now + 30000);
  const later = new Date(now + 24 * hour).toISOString();
  await handleSourceIngest(ingestRequest(sourceRun([failed('child-one', 'portal_request_rejected')], later)), env, now + 24 * hour);
  const check = (await latest(env))['child-one'];
  assert.deepEqual([check.lastStatus, check.lastReason, check.lastAttemptAt], ['unavailable', 'portal_request_rejected', later]);
  assert.equal(check.lastVerifiedAt, new Date(now + 20000).toISOString());
});

test('a portal rejection is reported for every child without holding the runner', async () => {
  const env = await environment();
  const harness = runnerHarness(env, { read: () => Promise.reject(new CheckError('portal_request_rejected')) });
  const summary = await harness.run();
  assert.deepEqual(summary.results.map(result => result.reason), ['portal_request_rejected', 'portal_request_rejected']);
  assert.equal(harness.saved[0].lastAttemptAt, new Date(now).toISOString());
  assert.deepEqual([harness.saved.at(-1).failures, harness.saved.at(-1).hold], [0, null]);
});

test('repeated sign-in failures hold the runner until the credentials change', async () => {
  const env = await environment();
  const reject = () => Promise.reject(new CheckError('sign_in_needs_attention'));
  const first = runnerHarness(env, { read: reject });
  await first.run();
  assert.deepEqual([first.saved.at(-1).failures, first.saved.at(-1).hold], [1, null]);
  const second = runnerHarness(env, { read: reject, state: first.saved.at(-1), now: now + 24 * hour });
  await second.run();
  assert.deepEqual(second.saved.at(-1).hold, { reason: 'sign_in_needs_attention', tag });

  const held = runnerHarness(env, { state: second.saved.at(-1), now: now + 48 * hour,
    read: () => assert.fail('a held runner must not sign in'),
    post: run => { held.posts.push(run); return Promise.resolve(true); } });
  const summary = await held.run();
  assert.deepEqual(summary.results.map(result => result.reason), ['held_after_sign_in_failure', 'held_after_sign_in_failure']);
  assert.equal(held.saved.length, 0);

  const changed = credentialTag(ingestToken, { ...credentials, password: 'new-synthetic-password' });
  assert.deepEqual(decide(second.saved.at(-1), { now: now + 48 * hour, interval: 6 * hour, tag: changed }), { proceed: true });
  assert.deepEqual(nextState(null, { now, tag, runFailure: 'service_rejected_credentials' }).hold,
    { reason: 'service_rejected_credentials', tag });
});

test('a second run inside the interval does nothing', async () => {
  const state = { lastAttemptAt: new Date(now - hour).toISOString(), failures: 0, hold: null };
  const harness = runnerHarness(await environment(), { state,
    read: () => assert.fail('must not sign in'), post: () => assert.fail('must not post') });
  assert.deepEqual(await harness.run(), { status: 'too_soon', results: [] });
  assert.equal(decide(state, { now: now + 6 * hour, interval: 6 * hour, tag }).proceed, true);
  assert.equal(intervalMs('5'), hour);
  assert.equal(intervalMs(undefined), 6 * hour);
  assert.equal(intervalMs('nonsense'), 6 * hour);
});

test('the Worker refuses unauthorized, unknown, mismatched, stale and oversized runs', async () => {
  const env = await environment();
  const status = async (run, token) => (await handleSourceIngest(ingestRequest(run, token), env, now + 30000)).status;
  assert.equal(await status(sourceRun([ok('child-one')]), 'c'.repeat(64)), 404);
  assert.equal(await status(sourceRun([ok('child-three')])), 400);
  assert.equal(await status(sourceRun([{ ...ok('child-one'), observation: observation('child-two') }])), 400);
  assert.equal(await status(sourceRun([ok('child-one'), ok('child-one')])), 400);
  assert.equal(await status(sourceRun([failed('child-one', 'Not A Code')])), 400);
  assert.equal(await status(sourceRun([ok('child-one')], new Date(now - 48 * hour).toISOString())), 400);
  assert.equal(await status('{'), 400);
  assert.equal(await status(' '.repeat(600 * 1024)), 413);
  assert.equal((await handleSourceIngest(ingestRequest(sourceRun([ok('child-one')])), { ...env, CHILD_IDS: '' }, now)).status, 503);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM provider_checks').get().n, 0);

  assert.equal((await worker.fetch(new Request('https://checker.example/v1/checks/latest'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://checker.example/'), env)).status, 404);
  assert.equal((await worker.fetch(ingestRequest(sourceRun([ok('child-one')]), 'c'.repeat(64)), env)).status, 404);
  assert.equal((await worker.fetch(ingestRequest(sourceRun([ok('child-three')])), env)).status, 400);
});

test('only children with a Source mapping are checked', () => {
  const source = { tabLabel: 'Alex', studentHeading: 'One, Alex' };
  const config = { defaultChild: 'alex-one', children: [
    { id: 'alex-one', displayName: 'Alex One', providers: { source } },
    { id: 'alex-two', displayName: 'Alex Two', providers: { schoology: { banner: 'You are viewing as Alex Two' } } }] };
  assert.deepEqual(sourceChildren(config).map(child => child.id), ['alex-one']);
  assert.throws(() => sourceChildren({ ...config, defaultChild: 'missing' }));
});
