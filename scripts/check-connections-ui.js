// Full browser -> authenticated API -> real SQLite -> claimed discovery result
// -> parent confirmation. Synthetic accounts only; no live school traffic.
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, SignJWT } from 'jose';
import { chromium } from 'playwright';
import { handlePilot } from '../src/cloudflare/pilot.js';
import { claimDiscovery, completeDiscovery } from '../src/cloudflare/connections.js';
import worker from '../src/cloudflare/worker.js';

const origin = 'https://pilot.example'; const now = Date.now();
const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
for (const name of ['0001_provider_checks.sql', '0002_pilot_families.sql', '0003_connections.sql', '0004_hosted_checks.sql']) {
  sqlite.exec(await readFile(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
}
sqlite.prepare('INSERT INTO pilot_families (id, created_at) VALUES (?, ?)').run('family-one', new Date(now).toISOString());
sqlite.prepare('INSERT INTO pilot_members (subject, family_id, email, created_at) VALUES (?, ?, ?, ?)')
  .run('parent-one', 'family-one', 'parent@example.com', new Date(now).toISOString());
const stmt = (sql, values = []) => ({ bind: (...args) => stmt(sql, args),
  run: () => Promise.resolve(sqlite.prepare(sql).run(...values)),
  all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }) });
const env = { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'pilot',
  CONNECTION_KEY: 'a'.repeat(64), SOURCE_DISCOVERY_TOKEN: 'b'.repeat(64), SCHOOLOGY_DISCOVERY_TOKEN: 'c'.repeat(64),
  SOURCE_CONNECTIONS_ENABLED: 'true', SCHOOLOGY_CONNECTIONS_ENABLED: 'true', BROWSER: {},
  DB: { prepare: sql => stmt(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } } };
const keys = await generateKeyPair('RS256');
const jwt = await new SignJWT({ email: 'parent@example.com' }).setProtectedHeader({ alg: 'RS256' }).setSubject('parent-one')
  .setAudience('pilot').setIssuer('https://example.cloudflareaccess.com').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const browserRequest = route.request(); assert.equal(new URL(browserRequest.url()).origin, origin);
    const request = new Request(browserRequest.url(), { method: browserRequest.method(), headers: { ...browserRequest.headers(), 'Cf-Access-Jwt-Assertion': jwt },
      ...(['GET', 'HEAD'].includes(browserRequest.method()) ? {} : { body: browserRequest.postData() }) });
    const response = new URL(browserRequest.url()).pathname.startsWith('/api/')
      ? await handlePilot(request, env, { keySet: keys.publicKey }) : await worker.fetch(request, env);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.goto(`${origin}/app`);
  const sourceForm = page.getByRole('form', { name: 'Connect The Source' });
  await sourceForm.getByLabel('Parent username').fill('source-parent');
  await sourceForm.getByLabel('Password').fill('synthetic-source-password');
  await sourceForm.getByRole('button', { name: 'Find linked children' }).click();
  await page.getByText('Waiting to check your account…').waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 1, 'submitted Source password field must be gone while queued');
  let job = await claimDiscovery(env, 'source');
  assert.equal(job.credentials.username, 'source-parent');
  await completeDiscovery(env, 'source', job.id, job.lease, { status: 'ok', children: [
    { remoteId: 'one', displayName: 'Alex One', mapping: { tabLabel: 'Alex', studentHeading: 'One, Alex', tabHref: '/guardian/home.html?student=1' } },
    { remoteId: 'two', displayName: 'Alex Two', mapping: { tabLabel: 'Alex', studentHeading: 'Two, Alex', tabHref: '/guardian/home.html?student=2' } },
  ] }); job.credentials.password = '';
  const two = page.locator('.candidate').filter({ hasText: 'Alex Two' });
  await two.getByRole('button', { name: 'Confirm child' }).click();
  await page.getByText('Alex Two was added. You can choose this child above.').waitFor();
  assert.equal(await page.getByLabel('Whose week are we looking at?').inputValue(), sqlite.prepare('SELECT id FROM pilot_children').get().id);
  const schoologyForm = page.getByRole('form', { name: 'Connect Schoology' });
  await schoologyForm.getByLabel('Parent email').fill('school-parent@example.com');
  await schoologyForm.getByLabel('Password').fill('synthetic-schoology-password');
  await schoologyForm.getByRole('button', { name: 'Find linked children' }).click();
  await page.getByText('Waiting to check your account…').waitFor();
  job = await claimDiscovery(env, 'schoology');
  await completeDiscovery(env, 'schoology', job.id, job.lease, { status: 'ok', children: [
    { remoteId: 'two', displayName: 'Alex Two', mapping: { banner: 'You are viewing as Alex Two', selectionHref: '/parent/index?child=2' } },
  ] }); job.credentials.password = '';
  const schoolTwo = page.locator('.connection').filter({ has: page.getByRole('heading', { name: 'Schoology', exact: true }) }).locator('.candidate');
  await schoolTwo.getByLabel('How should we add Alex Two?').selectOption({ label: 'Same child as Alex Two' });
  await schoolTwo.getByRole('button', { name: 'Confirm child' }).click();
  await page.getByText('Alex Two was added. You can choose this child above.').waitFor();
  const preview = await mkdtemp(join(tmpdir(), 'school-connections-preview-'));
  await page.screenshot({ path: `${preview}/connected-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Disconnect Schoology', exact: true }).click();
  await page.getByText('Disconnected. Saved credentials were deleted.').waitFor();
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pilot_children').get().n, 1);
  assert.equal(sqlite.prepare("SELECT credentials FROM pilot_connections WHERE provider='schoology'").get().credentials, null);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true);

  console.log('Connection UI passed: both accounts, discovered children, explicit cross-portal match, selected child and credential deletion. Synthetic data only.');
} finally { await browser.close(); sqlite.close(); }
