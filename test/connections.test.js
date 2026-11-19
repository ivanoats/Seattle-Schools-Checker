import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, SignJWT } from 'jose';
import { handlePilot, readBody } from '../src/cloudflare/pilot.js';
import { claimDiscovery, completeDiscovery, handleDiscoveryRunner, disconnectConnection } from '../src/cloudflare/connections.js';
import { sealCredentials, openCredentials } from '../src/cloudflare/connection-crypto.js';
import { discoverSourceChildren, discoverSchoologyChildren, schoologyChildHref } from '../src/portal-discovery.js';
import { chromium } from 'playwright';
import { discoverAccount } from '../src/discover-account.js';
import { consumeSourceChildSwitch, sourceSwitchId } from '../src/source-child-navigation.js';
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
    sqlite.exec(await readFile(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const n of [1, 2]) {
    sqlite.prepare('INSERT INTO pilot_families (id, created_at) VALUES (?, ?)').run(`family-${n}`, new Date(now).toISOString());
    sqlite.prepare('INSERT INTO pilot_members (subject, family_id, email, created_at) VALUES (?, ?, ?, ?)')
      .run(`parent-${n}`, `family-${n}`, `parent${n}@example.com`, new Date(now).toISOString());
  }
  const statement = (sql, values = []) => ({ bind: (...args) => statement(sql, args),
    all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }),
    run: () => Promise.resolve(sqlite.prepare(sql).run(...values)) });
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
  return handlePilot(new Request(`${origin}/api/pilot/${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'Cf-Access-Jwt-Assertion': jwt, 'Content-Type': 'application/json', Origin: origin, 'X-Pilot-Request': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env, { ...options, now: time });
}
async function state(env, parent = 1, time = now) { return (await (await call(env, 'connections', null, parent, time)).json()).connections; }

test('credential encryption is randomized and bound to family, service and credential revision', async () => {
  const connectionBinding = { id: 'connection', family_id: 'family-1', provider: 'source', revision: 'one' };
  const encrypted = await sealCredentials(credentials(), connectionBinding, 'a'.repeat(64));
  assert.doesNotMatch(encrypted, /parent@example|synthetic-password/);
  assert.notEqual(encrypted, await sealCredentials(credentials(), connectionBinding, 'a'.repeat(64)));
  assert.deepEqual(await openCredentials(encrypted, connectionBinding, 'a'.repeat(64)), credentials());
  for (const change of [{ family_id: 'family-2' }, { provider: 'schoology' }, { revision: 'two' }, { id: 'other' }]) {
    await assert.rejects(openCredentials(encrypted, { ...connectionBinding, ...change }, 'a'.repeat(64)));
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
  assert.equal((await call(env, 'connections/source/confirm', { candidateId: connections[0].candidates[1].id, childId: saved.childId })).status, 409);
  assert.equal(env.sqlite.prepare("SELECT remote_id FROM pilot_child_providers WHERE provider = 'source'").get().remote_id, 'student-1');
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
  const wrong = await handleDiscoveryRunner(new Request(`${origin}/v1/discovery/source/claim`, {
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

test('disconnect wins against a reconnect that already read the old credential revision', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const job = await claimDiscovery(env, 'source', now + 1000);
  await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [sourceChild()] }, now + 2000);
  const batch = env.DB.batch; let batches = 0;
  env.DB.batch = async statements => {
    if (++batches === 2) {
      // Submission has read the old revision and encrypted its payload, but
      // has not committed. A completed disconnect must cancel that attempt.
      env.DB.batch = batch;
      await disconnectConnection(env, { family_id: 'family-1' }, 'source', now + 61001);
    }
    return batch(statements);
  };
  assert.equal((await call(env, 'connections/source/connect', credentials(), 1, now + 61000)).status, 409);
  const connection = env.sqlite.prepare('SELECT status, credentials FROM pilot_connections').get();
  assert.equal(connection.status, 'disconnected'); assert.equal(connection.credentials, null);
  assert.equal(env.sqlite.prepare("SELECT count(*) AS n FROM pilot_discovery_jobs WHERE state = 'queued'").get().n, 0);
});

test('a parent submission expires only that family’s jobs', async () => {
  const env = await environment();
  await call(env, 'connections/source/connect', credentials(), 2);
  await call(env, 'connections/source/connect', credentials(), 1, now + 301000);
  assert.equal(env.sqlite.prepare("SELECT status FROM pilot_connections WHERE family_id = 'family-2'").get().status, 'queued');
});

test('runner errors are sanitized, credentials cleared and machine transport refuses redirects', async () => {
  const input = credentials();
  const result = await discoverAccount('source', input, () => Promise.reject(new Error('synthetic-password must never appear')));
  assert.deepEqual(result, { status: 'attention', reason: 'discovery_failed' });
  assert.deepEqual(input, { username: '', password: '' });
  for (const invalid of ['http://pilot.example', 'https://user:password@pilot.example', 'https://pilot.example/other', 'https://pilot.example/?token=x']) {
    assert.throws(() => discoveryEndpoint(invalid, 'claim'));
  }
  const calls = [];
  const output = await runSourceDiscovery({ origin, token: 'b'.repeat(64), launch: () => Promise.reject(new Error('synthetic-password')),
    request: (url, options) => {
      calls.push({ url, ...options });
      assert.equal(options.redirect, 'error');
      return Promise.resolve(Response.json(url.endsWith('/claim') ? { status: 'claimed', job: { id: crypto.randomUUID(),
        provider: 'source', lease: 'd'.repeat(64), expiresAt: new Date(Date.now() + 120000).toISOString(), credentials: credentials() } }
        : { status: 'recorded' }));
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
    let mismatch = false; let idTabs = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const n = url.searchParams.get('student') ?? '1';
      const name = n === '2' ? 'Two' : 'One';
      const navigation = idTabs ? `<div id="students-list"><ul>${[1,2].map(value => `<li class="${n === String(value) ? 'selected' : ''}"><a id="student-link-${value}" href="#" onclick="${n === String(value) ? 'return false' : `location.href='/guardian/home.html?student=${value}';return false`}">Alex</a></li>`).join('')}</ul></div>`
        : '<div id="students-list"><a href="/guardian/home.html?student=1">Alex</a><a href="/guardian/home.html?student=2">Alex</a></div>';
      const body = url.hostname === 'ps.seattleschools.org'
        ? `<button id="btnLogout">Sign out</button>${navigation}<h1>Grades: ${name}, Alex</h1>`
        : `<div id="child-session-banner">You are viewing as ${mismatch ? 'Other Child' : 'Alex One'}</div>
          <button aria-controls="child-menu" aria-expanded="false" onclick="document.getElementById('child-menu').hidden=false;this.setAttribute('aria-expanded','true')">Children</button>
          <div id="child-menu" hidden><a href="/parent/index?child=123">Alex One</a></div>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const found = await discoverSourceChildren(page);
    assert.deepEqual(found.map(c => c.displayName), ['Alex One', 'Alex Two']);
    assert.notEqual(found[0].remoteId, found[1].remoteId);
    idTabs = true;
    const idFound = await discoverSourceChildren(page);
    assert.deepEqual(idFound.map(c => c.displayName), ['Alex One', 'Alex Two']);
    assert.equal(idFound[0].mapping.tabId, 'student-link-1');
    const school = await discoverSchoologyChildren(page);
    assert.equal(school[0].mapping.selectionHref, '/parent/index?child=123');
    mismatch = true;
    await assert.rejects(discoverSchoologyChildren(page), { status: 'child_identity_unverified' });
  } finally { await browser.close(); }
});

test('Source discovers ID-less child links through the rendered student-switch form', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    let selected = '1'; const posted = [];
    await context.route('https://ps.seattleschools.org/**', async route => {
      if (route.request().method() === 'POST') {
        const request = route.request();
        const forged = { method: () => 'POST', isNavigationRequest: () => true, frame: () => page.mainFrame(),
          url: () => 'https://ps.seattleschools.org/guardian/home.html',
          headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
          postData: () => 'selected_student_id=2&password=unexpected' };
        assert.equal(consumeSourceChildSwitch(page, forged), false, 'extra form fields stay blocked');
        assert.equal(consumeSourceChildSwitch(page, request), true, 'the observed native child switch is allowed');
        assert.equal(consumeSourceChildSwitch(page, request), false, 'a second POST is blocked');
        selected = new URLSearchParams(request.postData()).get('selected_student_id');
        posted.push(selected);
      }
      await route.fulfill({ contentType: 'text/html', body: `<button id="btnLogout">Sign out</button>
        <form id="switch_student_form" action="/guardian/home.html" method="post"><input type="hidden" name="selected_student_id"></form>
        <ul id="students-list">${['1','2'].map(n => `<li class="${n === selected ? 'selected' : ''}"><a href="javascript:switchStudent(${n});">Alex</a></li>`).join('')}</ul>
        <h1>Grades: ${selected === '1' ? 'One' : 'Two'}, Alex</h1>
        <script>function switchStudent(id) { const f=document.getElementById('switch_student_form'); f.elements.namedItem('selected_student_id').value=id; f.submit(); }</script>` });
    });
    const children = await discoverSourceChildren(page);
    assert.deepEqual(children.map(c => c.displayName), ['Alex One', 'Alex Two']);
    assert.deepEqual(children.map(c => c.mapping.tabSwitchId), ['1', '2']);
    assert.notEqual(children[0].remoteId, children[1].remoteId);
    assert.deepEqual(posted, ['2'], 'the already selected child needs no repeated POST');
  } finally { await browser.close(); }
});


test('Source switch mappings survive confirmation; arbitrary script hrefs and invalid IDs are rejected', async () => {
  // Literal portal URL used only as parser input; never evaluated. skipcq
  assert.equal(sourceSwitchId('javascript:switchStudent(123);'), '123');
  // Malformed portal URLs must remain literal rejection fixtures. skipcq
  for (const href of ['javascript:other(123);', 'javascript:switchStudent(123);other();', 'https://bad.example/']) {
    assert.equal(sourceSwitchId(href), null);
  }
  const env = await environment();
  await call(env, 'connections/source/connect', credentials());
  const job = await claimDiscovery(env, 'source', now + 1000);
  const child = { ...sourceChild(), remoteId: 'student-switch:123',
    mapping: { tabLabel: 'Alex', tabSwitchId: '123', studentHeading: 'One, Alex' } };
  await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [child] }, now + 2000);
  const connection = (await state(env))[0];
  assert.equal(connection.status, 'ready');
  assert.equal((await call(env, 'connections/source/confirm', { candidateId: connection.candidates[0].id })).status, 200);
  const mapping = JSON.parse(env.sqlite.prepare('SELECT mapping FROM pilot_child_providers').get().mapping);
  assert.equal(mapping.tabSwitchId, '123');
});

test('Schoology discovers modern account-menu child links without including school subtitles', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    let mismatch = false;
    await context.route('https://app.schoology.com/**', async route => {
      const selected = /\/parent\/switch_child\/(101|202)$/.exec(route.request().url())?.[1];
      const name = mismatch ? 'Other Child' : selected === '101' ? 'Alex One' : 'Alex Two';
      await route.fulfill({ contentType: 'text/html', body: `<a href="/calendar">Calendar</a><button>Courses</button>
        ${selected ? `<div id="child-session-banner">You are viewing as ${name}</div>` : ''}
        <nav aria-label="Header Navigation"><div data-sgy-sitenav="header-my-account-menu">
          <button data-sgy-sitenav="nav-trigger" aria-haspopup="true" aria-expanded="false"
            onclick="document.getElementById('picker').hidden=false;this.setAttribute('aria-expanded','true')">Parent Example</button>
          <ul id="picker" role="menu" hidden>
            <li><a role="menuitem" href="/settings/account">Settings</a></li>
            <li><a role="menuitem" href="/parent/switch_child/101">Alex One<p>Example High School</p></a></li>
            <li><a role="menuitem" href="/parent/switch_child/202">Alex Two<p>Example High School</p></a></li>
          </ul>
        </div></nav>` });
    });
    const children = await discoverSchoologyChildren(page);
    assert.deepEqual(children.map(c => c.displayName), ['Alex One', 'Alex Two']);
    assert.deepEqual(children.map(c => c.mapping.selectionHref), ['/parent/switch_child/101', '/parent/switch_child/202']);
    assert.deepEqual(children.map(c => c.mapping.banner), ['You are viewing as Alex One', 'You are viewing as Alex Two']);
    mismatch = true;
    await assert.rejects(discoverSchoologyChildren(page), { status: 'child_identity_unverified' });
  } finally { await browser.close(); }
});


test('modern Schoology selection mappings are validated and preserved through confirmation', async () => {
  assert.equal(schoologyChildHref('/parent/switch_child/123'), '/parent/switch_child/123');
  assert.equal(schoologyChildHref('/parent/index?child=123'), '/parent/index?child=123');
  for (const href of ['/parent/switch_child/123?other=1', '/parent/switch_child/123#other',
    '/parent/switch_child/not-a-number', '/parent/index?child=123&child=456',
    'https://outside.example/parent/switch_child/123', 'https://user:secret@app.schoology.com/parent/switch_child/123']) {
    assert.equal(schoologyChildHref(href), null);
  }
  const env = await environment();
  await call(env, 'connections/schoology/connect', credentials());
  const job = await claimDiscovery(env, 'schoology', now + 1000);
  const child = { ...schoologyChild(), mapping: { banner: 'You are viewing as Alex One', selectionHref: '/parent/switch_child/123' } };
  await completeDiscovery(env, 'schoology', job.id, job.lease, { status: 'ok', children: [child] }, now + 2000);
  const connection = (await state(env))[1];
  assert.equal(connection.status, 'ready');
  assert.equal((await call(env, 'connections/schoology/confirm', { candidateId: connection.candidates[0].id })).status, 200);
  const mapping = JSON.parse(env.sqlite.prepare('SELECT mapping FROM pilot_child_providers').get().mapping);
  assert.equal(mapping.selectionHref, '/parent/switch_child/123');
});

test('Schoology discovery loads its external header under the real read policy', async () => {
  const { loginRequestAction } = await import('../scripts/browser-run/schoology-login.js');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    let headerLoads = 0;
    const header = `<div data-sgy-sitenav="header-my-account-menu">
      <button data-sgy-sitenav="nav-trigger" aria-haspopup="true" aria-expanded="false"
        onclick="document.getElementById('remote-picker').hidden=false;this.setAttribute('aria-expanded','true')">Alex One</button>
      <ul id="remote-picker" hidden><li><a href="/parent/switch_child/101">Alex One<p>Example High School</p></a></li></ul>
    </div>`;
    await context.route('**/*', async route => {
      const request = route.request();
      if (loginRequestAction({ request: { url: request.url(), method: request.method() } }, false) !== 'continue_read') {
        await route.abort(); return;
      }
      if (new URL(request.url()).origin === 'https://ui.schoology.com') {
        headerLoads++;
        await route.fulfill({ contentType: 'application/javascript', body: `document.getElementById('header').innerHTML=${JSON.stringify(header)};` });
      } else {
        await route.fulfill({ contentType: 'text/html', body: `<div id="child-session-banner">You are viewing as Alex One</div>
          <nav id="header"></nav><script src="https://ui.schoology.com/platform/site-navigation-ui/bundle.test.js"></script>` });
      }
    });
    const children = await discoverSchoologyChildren(page);
    assert.equal(children[0].displayName, 'Alex One');
    assert.ok(headerLoads > 0, 'the external script must load for the account menu to exist');
  } finally { await browser.close(); }
});

test('discovery claims retain the full lease window before the original job expiry', async () => {
  for (const provider of ['source', 'schoology']) {
    const env = await environment();
    await call(env, `connections/${provider}/connect`, credentials());
    const late = await claimDiscovery(env, provider, now + 270000);
    assert.equal(late, null, 'a late claim must not advertise a lease past the job deadline');
    const timelyEnv = await environment();
    await call(timelyEnv, `connections/${provider}/connect`, credentials());
    const timely = await claimDiscovery(timelyEnv, provider, now + 179999);
    assert.ok(timely);
    assert.equal(Date.parse(timely.expiresAt), now + 299999);
    assert.equal(await completeDiscovery(timelyEnv, provider, timely.id, timely.lease,
      { status: 'ok', children: provider === 'source' ? [sourceChild()] : [schoologyChild()] }, now + 220000), true);
  }
});

test('Source resolves relative child links against the current document', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://ps.seattleschools.org/**', async route => {
      const id = new URL(route.request().url()).searchParams.get('student') ?? '1';
      await route.fulfill({ contentType: 'text/html', body: `<button id="btnLogout">Sign out</button>
        <div id="students-list"><a href="home.html?student=1">Alex</a><a href="?student=2">Alex</a></div>
        <h1>Grades: ${id === '1' ? 'One' : 'Two'}, Alex</h1>` });
    });
    const children = await discoverSourceChildren(page);
    assert.deepEqual(children.map(child => child.displayName), ['Alex One', 'Alex Two']);
  } finally { await browser.close(); }
});
