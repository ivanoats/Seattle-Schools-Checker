import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, SignJWT } from 'jose';
import { handlePilot, readBody } from '../src/cloudflare/pilot.js';
import { claimDiscovery, completeDiscovery, handleDiscoveryRunner } from '../src/cloudflare/connections.js';
import { sealCredentials, openCredentials } from '../src/cloudflare/connection-crypto.js';
import { discoverSourceChildren, discoverSchoologyChildren } from '../src/portal-discovery.js';
import { chromium } from 'playwright';
import { discoverAccount } from '../src/discover-account.js';
import { runSourceDiscovery, discoveryEndpoint } from '../scripts/source-runner/discover.js';

const origin = 'https://pilot.example';
const now = Date.parse('2026-11-18T19:00:00Z');
const keys = await generateKeyPair('RS256');
const options = { keySet: keys.publicKey, now };
const credentials = () => ({ username: 'parent@example.com', password: 'synthetic-password' });
const sourceChild = (n = 1) => ({ remoteId: `student-${n}`, displayName: `Alex ${n === 1 ? 'One' : 'Two'}`,
  mapping: { tabLabel: 'Alex', tabHref: `/guardian/home.html?student=${n}`, studentHeading: `${n === 1 ? 'One' : 'Two'}, Alex` } });
const schoologyChild = () => ({ remoteId: 'parent-child-123', displayName: 'Alex One',
  mapping: { banner: 'You are viewing as Alex One', selectionHref: '/parent/index?child=123' } });

async function environment() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
  for (const name of ['0001_provider_checks.sql', '0002_pilot_families.sql', '0003_connections.sql']) {
    sqlite.exec(await readFile(new URL('../worker/migrations/' + name, import.meta.url), 'utf8'));
  }
  for (const n of [1, 2]) {
    sqlite.prepare('INSERT INTO pilot_families (id, created_at) VALUES (?, ?)').run(`family-${n}`, new Date(now).toISOString());
    sqlite.prepare('INSERT INTO pilot_members (subject, family_id, email, created_at) VALUES (?, ?, ?, ?)')
      .run(`parent-${n}`, `family-${n}`, `parent${n}@example.com`, new Date(now).toISOString());
  }
  const statement = (sql, values = []) => ({ bind: (...args) => statement(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => sqlite.prepare(sql).run(...values) });
  return { sqlite, APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'pilot',
    CONNECTION_KEY: 'a'.repeat(64), SOURCE_DISCOVERY_TOKEN: 'b'.repeat(64), SCHOOLOGY_DISCOVERY_TOKEN: 'c'.repeat(64),
    SOURCE_CONNECTIONS_ENABLED: 'true', SCHOOLOGY_CONNECTIONS_ENABLED: 'true', BROWSER: {},
    DB: { prepare: sql => statement(sql), batch: async statements => {
      sqlite.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } } };
}
async function call(env, path, body, parent = 1, time = now) {
  const jwt = await new SignJWT({ email: `parent${parent}@example.com` }).setProtectedHeader({ alg: 'RS256' })
    .setSubject(`parent-${parent}`).setAudience('pilot').setIssuer('https://example.cloudflareaccess.com')
    .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 3600).sign(keys.privateKey);
  return handlePilot(new Request(origin + '/api/pilot/' + path, { method: body ? 'POST' : 'GET',
    headers: { 'Cf-Access-Jwt-Assertion': jwt, 'Content-Type': 'application/json', Origin: origin, 'X-Pilot-Request': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env, { ...options, now: time });
}
async function state(env, parent = 1, time = now) { return (await (await call(env, 'connections', null, parent, time)).json()).connections; }

test('credential encryption is randomized and bound to family, service and credential revision', async () => {
  const c = { id: 'connection', family_id: 'family-1', provider: 'source', revision: 'one' };
  const encrypted = await sealCredentials(credentials(), c, 'a'.repeat(64));
  assert.doesNotMatch(encrypted, /parent@example|synthetic-password/);
  assert.notEqual(encrypted, await sealCredentials(credentials(), c, 'a'.repeat(64)));
  assert.deepEqual(await openCredentials(encrypted, c, 'a'.repeat(64)), credentials());
  for (const change of [{ family_id: 'family-2' }, { provider: 'schoology' }, { revision: 'two' }, { id: 'other' }]) {
    await assert.rejects(openCredentials(encrypted, { ...c, ...change }, 'a'.repeat(64)));
  }
});

test('parent connects both accounts, confirms discovered children and explicitly matches portals to one child', async () => {
  const env = await environment();
  for (const provider of ['source', 'schoology']) {
    assert.equal((await call(env, `connections/${provider}/connect`, credentials())).status, 202);
    assert.equal((await call(env, `connections/${provider}/connect`, credentials())).status, 409);
    const job = await claimDiscovery(env, provider, now + 1000);
    assert.deepEqual(job.credentials, credentials());
    assert.equal(await claimDiscovery(env, provider, now + 1001), null);
    const children = provider === 'source' ? [sourceChild(1), sourceChild(2)] : [schoologyChild()];
    assert.equal(await completeDiscovery(env, provider, job.id, job.lease, { status: 'ok', children }, now + 2000), true);
    assert.equal(await completeDiscovery(env, provider, job.id, job.lease, { status: 'ok', children }, now + 2000), false);
  }
  const connections = await state(env);
  assert.equal(connections[0].candidates.length, 2);
  assert.doesNotMatch(JSON.stringify(connections), /synthetic-password|studentHeading|remoteId|selectionHref|ciphertext/);
  assert.equal((await call(env, 'connections/source/confirm', { candidateId: connections[0].candidates[0].id }, 2)).status, 404);
  const saved = await (await call(env, 'connections/source/confirm', { candidateId: connections[0].candidates[0].id })).json();
  assert.equal(saved.status, 'linked');
  assert.equal((await call(env, 'connections/schoology/confirm', { candidateId: connections[1].candidates[0].id, childId: saved.childId })).status, 200);
  const list = await (await call(env, 'children')).json();
  assert.equal(list.children.length, 1);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_child_providers').get().n, 2);
  assert.equal((await (await call(env, 'children', null, 2)).json()).children.length, 0);
  assert.doesNotMatch(JSON.stringify(env.sqlite.prepare('SELECT * FROM pilot_connections').all()), /synthetic-password/);
});

test('disconnect invalidates in-flight results, wipes credentials and forbids old candidates', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const job = await claimDiscovery(env, 'source', now + 1000);
  await call(env, 'connections/source/disconnect', {});
  assert.equal(env.sqlite.prepare('SELECT credentials FROM pilot_connections').get().credentials, null);
  assert.equal(await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [sourceChild()] }, now + 2000), false);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_candidates').get().n, 0);
  assert.equal((await state(env))[0].status, 'disconnected');
});

test('jobs expire without another login; wrong-provider tokens and leases cannot complete them', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const wrong = await handleDiscoveryRunner(new Request(origin + '/v1/discovery/source/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${env.SCHOOLOGY_DISCOVERY_TOKEN}` } }), env, 'source', 'claim', readBody, now);
  assert.equal(wrong.status, 404);
  const job = await claimDiscovery(env, 'source', now + 1000);
  assert.equal(await completeDiscovery(env, 'source', job.id, '0'.repeat(64), { status: 'ok', children: [sourceChild()] }, now + 2000), false);
  assert.equal(await completeDiscovery(env, 'schoology', job.id, job.lease, { status: 'ok', children: [schoologyChild()] }, now + 2000), false);
  assert.equal(await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [sourceChild()] }, now + 130000), false);
  assert.equal((await state(env, 1, now + 130000))[0].reason, 'discovery_expired');
  assert.equal(await claimDiscovery(env, 'source', now + 131000), null);
});

test('unverified layouts and malformed identities never become child choices; failures are explicit', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const job = await claimDiscovery(env, 'source', now + 1000);
  await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [{ ...sourceChild(), mapping: { tabHref: 'https://bad.example' } }] }, now + 2000);
  assert.equal((await state(env))[0].reason, 'discovery_unverified');
  assert.equal((await state(env))[0].candidates.length, 0);
  assert.equal((await call(env, 'connections/source/connect', credentials(), 1, now + 3000)).status, 429);
  assert.equal((await call({ ...env, SOURCE_CONNECTIONS_ENABLED: 'false' }, 'connections/source/connect', credentials())).status, 503);
});

test('family revocation prevents new runner claims and in-flight completion', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const job = await claimDiscovery(env, 'source', now + 1000);
  env.sqlite.prepare("UPDATE pilot_families SET revoked_at = '2026-11-18' WHERE id = 'family-1'").run();
  assert.equal(await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [sourceChild()] }, now + 2000), false);
  assert.equal(await claimDiscovery(env, 'source', now + 3000), null);
  assert.equal((await call(env, 'connections')).status, 403);
});

test('runner errors are sanitized, credentials cleared and machine transport refuses redirects', async () => {
  const input = credentials();
  const result = await discoverAccount('source', input, async () => { throw new Error('synthetic-password must never appear'); });
  assert.deepEqual(result, { status: 'attention', reason: 'discovery_failed' });
  assert.deepEqual(input, { username: '', password: '' });
  for (const invalid of ['http://pilot.example', 'https://user:password@pilot.example', 'https://pilot.example/other', 'https://pilot.example/?token=x']) {
    assert.throws(() => discoveryEndpoint(invalid, 'claim'));
  }
  const calls = [];
  const output = await runSourceDiscovery({ origin, token: 'b'.repeat(64), launch: async () => { throw new Error('synthetic-password'); },
    request: async (url, options) => {
      calls.push({ url, ...options });
      assert.equal(options.redirect, 'error');
      return Response.json(url.endsWith('/claim') ? { status: 'claimed', job: { id: crypto.randomUUID(),
        provider: 'source', lease: 'd'.repeat(64), expiresAt: new Date(Date.now() + 120000).toISOString(), credentials: credentials() } }
        : { status: 'recorded' });
    } });
  assert.equal(output.status, 'recorded');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].body, /synthetic-password|parent@example/);
});

test('an expired queued job cannot sign in, and a reconnect can replace the same confirmed provider mapping', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  assert.equal((await state(env, 1, now + 300001))[0].reason, 'discovery_expired');
  assert.equal(await claimDiscovery(env, 'source', now + 300002), null);
  assert.equal((await call(env, 'connections/source/connect', credentials(), 1, now + 301000)).status, 202);
  const job = await claimDiscovery(env, 'source', now + 301001);
  await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [sourceChild()] }, now + 302000);
  const candidate = (await state(env, 1, now + 302000))[0].candidates[0];
  const saved = await (await call(env, 'connections/source/confirm', { candidateId: candidate.id }, 1, now + 302000)).json();
  assert.equal((await call(env, 'connections/source/connect', credentials(), 1, now + 370000)).status, 202);
  const next = await claimDiscovery(env, 'source', now + 370001);
  await completeDiscovery(env, 'source', next.id, next.lease, { status: 'ok', children: [sourceChild()] }, now + 371000);
  assert.equal((await call(env, 'connections/source/confirm', { candidateId: candidate.id }, 1, now + 371000)).status, 404);
  const current = (await state(env, 1, now + 371000))[0].candidates[0];
  assert.equal((await call(env, 'connections/source/confirm', { candidateId: current.id, childId: saved.childId }, 1, now + 371000)).status, 200);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM pilot_children').get().n, 1);
});

test('rendered portal discovery verifies two same-first-name children and rejects mismatched banners', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(1000);
    let mismatch = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const n = url.searchParams.get('student') ?? '1';
      const name = n === '2' ? 'Two' : 'One';
      const body = url.hostname === 'ps.seattleschools.org'
        ? `<button id="btnLogout">Sign out</button><div id="students-list"><a href="/guardian/home.html?student=1">Alex</a><a href="/guardian/home.html?student=2">Alex</a></div><h1>Grades: ${name}, Alex</h1>`
        : `<div id="child-session-banner">You are viewing as ${mismatch ? 'Other Child' : 'Alex One'}</div>
          <button aria-controls="child-menu" aria-expanded="false" onclick="document.getElementById('child-menu').hidden=false;this.setAttribute('aria-expanded','true')">Children</button>
          <div id="child-menu" hidden><a href="/parent/index?child=123">Alex One</a></div>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const found = await discoverSourceChildren(page);
    assert.deepEqual(found.map(c => c.displayName), ['Alex One', 'Alex Two']);
    assert.notEqual(found[0].remoteId, found[1].remoteId);
    const school = await discoverSchoologyChildren(page);
    assert.equal(school[0].mapping.selectionHref, '/parent/index?child=123');
    mismatch = true;
    await assert.rejects(discoverSchoologyChildren(page), { status: 'child_identity_unverified' });
  } finally { await browser.close(); }
});
