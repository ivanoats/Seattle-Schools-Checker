import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { accessIdentity } from '../src/cloudflare/pilot-auth.js';
import { handlePilot } from '../src/cloudflare/pilot.js';
import worker from '../src/cloudflare/worker.js';

const origin = 'https://school.example';
const issuer = 'https://example.cloudflareaccess.com';
const now = Date.parse('2026-11-18T19:00:00Z');
const keys = await generateKeyPair('RS256');
const options = { keySet: keys.publicKey, now };
const guardian = { sub: 'guardian-one', email: 'one@example.com' };
const other = { sub: 'guardian-two', email: 'two@example.com' };

async function token(identity = guardian, claims = {}, key = keys.privateKey) {
  return new SignJWT({ email: identity.email, ...claims }).setProtectedHeader({ alg: 'RS256' })
    .setSubject(identity.sub).setIssuer(issuer).setAudience('pilot').setIssuedAt(now / 1000)
    .setExpirationTime(now / 1000 + 3600).sign(key);
}

async function environment() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_provider_checks.sql', '0002_pilot_families.sql']) {
    sqlite.exec(await readFile(new URL('../worker/migrations/' + file, import.meta.url), 'utf8'));
  }
  const statement = (sql, values = []) => ({
    bind: (...args) => statement(sql, args),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...values)),
    all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }),
  });
  const DB = { prepare: sql => statement(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = await Promise.all(statements.map(s => s.run())); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { DB, sqlite, STATUS_TOKEN: 'a'.repeat(64), PILOT_ADMIN_TOKEN: 'b'.repeat(64), ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'pilot', APP_ORIGIN: origin };
}

async function call(env, path, { identity = guardian, body, jwt, ...headers } = {}) {
  return handlePilot(new Request(origin + '/api/pilot/' + path, {
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'Cf-Access-Jwt-Assertion': jwt ?? await token(identity), 'Content-Type': 'application/json',
      Origin: origin, 'X-Pilot-Request': '1', ...headers },
  }), env, options);
}

async function invite(env, email = guardian.email) {
  const response = await call(env, 'operator/invites', { body: { email }, Authorization: `Bearer ${env.PILOT_ADMIN_TOKEN}` });
  assert.equal(response.status, 201);
  const data = await response.json();
  return { ...data, token: new URL(data.url).hash.slice('#invite='.length) };
}

async function join(env, identity = guardian) {
  const invitation = await invite(env, identity.email);
  assert.equal((await call(env, 'invitation', { identity, body: { token: invitation.token } })).status, 200);
  return invitation;
}

test('Access checks signature, issuer, audience, expiry and identity instead of trusting headers', async () => {
  const env = await environment();
  const request = jwt => new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt, 'Cf-Access-Authenticated-User-Email': guardian.email } });
  assert.deepEqual(await accessIdentity(request(await token()), env, options), { subject: guardian.sub, email: guardian.email });
  const unrelated = await generateKeyPair('RS256');
  assert.equal(await accessIdentity(request(await token(guardian, {}, unrelated.privateKey)), env, options), null);
  const wrongAudience = await new SignJWT({ email: guardian.email }).setProtectedHeader({ alg: 'RS256' }).setSubject(guardian.sub)
    .setIssuer(issuer).setAudience('other').setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 3600).sign(keys.privateKey);
  assert.equal(await accessIdentity(request(wrongAudience), env, options), null);
  assert.equal(await accessIdentity(request(await token()), env, { ...options, now: now + 7200000 }), null);
  assert.equal(await accessIdentity(request(await token()), { ...env, ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' }, options), null);
  assert.equal(await accessIdentity(new Request(origin, { headers: { 'Cf-Access-Authenticated-User-Email': guardian.email } }), env, options), null);
});

test('invitations are email-bound, hashed, expiring, one-time grants with idempotent acceptance', async () => {
  const env = await environment();
  assert.equal((await call(env, 'session')).status, 403);
  assert.equal((await call(env, 'operator/invites', { body: { email: guardian.email } })).status, 404);
  assert.equal((await call(env, 'operator/invites', { body: { email: guardian.email }, Authorization: `Bearer ${env.STATUS_TOKEN}` })).status, 404);
  const i = await invite(env);
  assert.notEqual(env.sqlite.prepare('SELECT token_hash FROM pilot_invites').get().token_hash, i.token);
  assert.equal((await call(env, 'invitation', { identity: other, body: { token: i.token } })).status, 403);
  assert.equal((await call(env, 'invitation', { body: { token: i.token } })).status, 200);
  assert.equal((await call(env, 'invitation', { body: { token: i.token } })).status, 200);
  assert.equal((await call(env, 'invitation', { identity: { ...guardian, sub: 'different-subject' }, body: { token: i.token } })).status, 403);
  const expired = await invite(env, other.email);
  env.sqlite.prepare('UPDATE pilot_invites SET expires_at = ? WHERE family_id = ?').run('2020-01-01', expired.familyId);
  assert.equal((await call(env, 'invitation', { identity: other, body: { token: expired.token } })).status, 403);
  const session = await (await call(env, 'session')).json();
  assert.equal(session.connectionsAvailable, false);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_members').get().n, 1);
});

test('two families and overlapping child IDs cannot read or select each other’s records', async () => {
  const env = await environment();
  const a = await join(env); const b = await join(env, other);
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(a.familyId, 'same-child', 'Alex One');
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(b.familyId, 'same-child', 'Alex Two');
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(b.familyId, 'only-two', 'Sibling Two');
  assert.deepEqual((await (await call(env, 'children')).json()).children, [{ id: 'same-child', displayName: 'Alex One' }]);
  assert.equal((await call(env, 'selection', { body: { childId: 'only-two', familyId: b.familyId } })).status, 404);
  assert.equal((await call(env, 'report?childId=only-two&familyId=' + b.familyId)).status, 404);
  assert.equal((await call(env, 'selection', { body: { childId: 'same-child' } })).status, 200);
  assert.equal((await (await call(env, 'session')).json()).selectedChildId, 'same-child');
  assert.equal((await (await call(env, 'session', { identity: other })).json()).selectedChildId, null);
  const report = await (await call(env, 'report?childId=same-child')).json();
  assert.equal(report.child.displayName, 'Alex One');
  assert.equal(report.report.source, null);
  assert.equal(report.providers[0].lastStatus, 'not_checked');
  env.sqlite.prepare('UPDATE pilot_families SET revoked_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.familyId);
  assert.equal((await call(env, 'children')).status, 403);
  assert.equal((await call(env, 'report?childId=same-child')).status, 403);
  assert.equal((await call(env, 'session', { identity: other })).status, 200);
});

test('failed checks preserve verified data with timestamps, unknown coverage and submission evidence', async () => {
  const env = await environment(); const i = await join(env);
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(i.familyId, 'child-one', 'Alex One');
  const insert = env.sqlite.prepare(`INSERT INTO provider_checks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const timestamp = new Date(now - 60000).toISOString();
  const source = { version: 1, provider: 'source', childId: 'child-one', term: 's1', observedAt: timestamp,
    courses: [{ course: 'French', semester: 'C', missing: null, rows: null }], attendance: { absences: [], tardies: [] } };
  const assignment = { course: 'Literature', assignment: 'Essay', url: 'https://app.schoology.com/assignment/123',
    submissionStatus: 'This material has been submitted but not yet graded' };
  const schoology = { version: 1, provider: 'schoology', childId: 'child-one', observedAt: timestamp,
    overdue: [assignment], upcoming: [], recentlyCompleted: [assignment], events: [] };
  for (const observation of [source, schoology]) insert.run(crypto.randomUUID(), i.familyId, 'child-one', observation.provider,
    'synthetic', 'ok', null, timestamp, timestamp, JSON.stringify(observation), timestamp);
  // More than 100 failures must not erase the last verified observation.
  for (let n = 0; n < 101; n++) insert.run(crypto.randomUUID(), i.familyId, 'child-one', 'source', 'synthetic', 'unavailable',
    'sign_in_needs_attention', new Date(now - n).toISOString(), null, null, new Date(now).toISOString());
  const response = await call(env, 'report?childId=child-one');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json();
  assert.equal(data.providers[0].lastStatus, 'unavailable');
  assert.equal(data.providers[0].observedAt, timestamp);
  assert.equal(data.report.source.courses[0].missing, null);
  assert.equal(data.report.schoology.confirmTurnIn.length, 0);
  assert.equal(data.report.schoology.awaitingGrade[0].alsoListedOverdue, true);
});

test('CSRF, oversize bodies and missing configuration fail closed; UI has no embedded records', async () => {
  const env = await environment();
  const i = await invite(env);
  assert.equal((await call(env, 'invitation', { body: { token: i.token }, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(env, 'invitation', { body: { token: i.token }, 'X-Pilot-Request': '' })).status, 403);
  assert.equal((await call(env, 'invitation', { body: { token: 'a'.repeat(5000) } })).status, 400);
  assert.equal((await call({ ...env, ACCESS_AUD: '' }, 'session')).status, 503);
  assert.equal((await call(env, 'session', { jwt: 'forged' })).status, 401);
  const shell = await worker.fetch(new Request(origin + '/app'), env);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(await shell.text(), /guardian-one|one@example.com|London|Storck/);
  assert.equal((await worker.fetch(new Request(origin + '/'), env)).status, 404);
});

test('revoking a family invalidates every read and an old invitation cannot restore it', async () => {
  const env = await environment();
  const i = await join(env);
  assert.equal((await call(env, 'session')).status, 200);
  env.sqlite.prepare('UPDATE pilot_families SET revoked_at = ? WHERE id = ?').run(new Date(now).toISOString(), i.familyId);
  for (const path of ['session', 'children', 'report?childId=child-one']) assert.equal((await call(env, path)).status, 403);
  assert.equal((await call(env, 'selection', { body: { childId: 'child-one' } })).status, 403);
  assert.equal((await call(env, 'invitation', { body: { token: i.token } })).status, 403);
  const replacement = await invite(env);
  assert.equal((await call(env, 'invitation', { body: { token: replacement.token } })).status, 200);
  assert.equal((await call(env, 'session')).status, 200);
  assert.equal(env.sqlite.prepare('SELECT family_id FROM pilot_members WHERE subject = ?').get(guardian.sub).family_id, replacement.familyId);
  assert.equal((await call(env, 'invitation', { body: { token: i.token } })).status, 403);
});

test('selection is remembered only in the authenticated family and unknown children are not enumerable', async () => {
  const env = await environment();
  const one = await join(env); const two = await join(env, other);
  for (const family of [one, two]) env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)')
    .run(family.familyId, 'same-id', family.familyId === one.familyId ? 'Alex One' : 'Alex Two');
  env.sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run(two.familyId, 'other-only', 'Private Child');
  const children = await (await call(env, 'children')).json();
  assert.deepEqual(children.children, [{ id: 'same-id', displayName: 'Alex One' }]);
  assert.equal((await call(env, 'report?childId=other-only')).status, 404);
  assert.equal((await call(env, 'selection', { body: { childId: 'other-only' } })).status, 404);
  assert.equal((await call(env, 'selection', { body: { childId: 'same-id', familyId: two.familyId } })).status, 200);
  assert.equal((await (await call(env, 'session')).json()).selectedChildId, 'same-id');
  assert.equal((await (await call(env, 'session', { identity: other })).json()).selectedChildId, null);
  const ownReport = await (await call(env, 'report?childId=same-id&familyId=' + two.familyId)).json();
  assert.equal(ownReport.child.displayName, 'Alex One');
});
