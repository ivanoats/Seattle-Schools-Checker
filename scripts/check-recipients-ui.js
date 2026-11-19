// Synthetic authenticated browser checks. No school portal or email service is contacted.
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { chromium } from 'playwright';
import { handlePilot } from '../src/cloudflare/pilot.js';
import worker from '../src/cloudflare/worker.js';

const origin = 'https://pilot.example';
const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
for (const migration of ['0001_provider_checks.sql', '0002_pilot_families.sql', '0003_connections.sql',
  '0004_hosted_checks.sql', '0005_check_attempts.sql', '0006_report_recipients.sql']) {
  sqlite.exec(await readFile(new URL(`../worker/migrations/${migration}`, import.meta.url), 'utf8'));
}
const now = Date.now();
sqlite.prepare('INSERT INTO pilot_families VALUES (?, ?, NULL)').run('family-one', new Date(now).toISOString());
sqlite.prepare('INSERT INTO pilot_members VALUES (?, ?, ?, ?, ?)').run('parent-one', 'family-one', 'parent@example.com', null, new Date(now).toISOString());
for (const [childId, name] of [['alex-one', 'Alex One'], ['alex-two', 'Alex Two']]) {
  sqlite.prepare('INSERT INTO pilot_children VALUES (?, ?, ?)').run('family-one', childId, name);
}
const statement = (sql, values = []) => ({ bind: (...args) => statement(sql, args),
  all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...values) }), run: () => Promise.resolve(sqlite.prepare(sql).run(...values)) });
const env = { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'pilot',
  DB: { prepare: sql => statement(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } };
const keys = await generateKeyPair('RS256');
const jwt = await new SignJWT({ email: 'parent@example.com' }).setProtectedHeader({ alg: 'RS256' }).setSubject('parent-one')
  .setAudience('pilot').setIssuer('https://example.cloudflareaccess.com').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const recipientRead = Promise.withResolvers(); const releaseRecipients = Promise.withResolvers();
  let delayFirstRead = true;
  let delayNextSave = false; let savedSignal = null; let releaseSave = null;
  await page.route('**/*', async route => {
    const browserRequest = route.request(); const url = new URL(browserRequest.url());
    assert.equal(url.origin, origin, 'no external resources, portals or email services');
    const request = new Request(url.href, { method: browserRequest.method(),
      headers: { ...browserRequest.headers(), 'Cf-Access-Jwt-Assertion': jwt },
      ...(browserRequest.method() === 'POST' ? { body: browserRequest.postData() } : {}) });
    const response = url.pathname.startsWith('/api/')
      ? await handlePilot(request, env, { keySet: keys.publicKey }) : await worker.fetch(request, env);
    if (url.pathname.endsWith('/report-recipients') && request.method === 'GET' && delayFirstRead) {
      delayFirstRead = false; recipientRead.resolve(); await releaseRecipients.promise;
    }
    if (url.pathname.endsWith('/report-recipients') && request.method === 'POST' && delayNextSave) {
      delayNextSave = false; savedSignal.resolve(); await releaseSave.promise;
    }
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.goto(`${origin}/app`);
  const picker = page.getByLabel('Whose week are we looking at?');
  const input = page.getByLabel('Recipients for this child');
  const save = page.getByRole('button', { name: 'Save recipients', exact: true });
  const status = page.locator('#recipient-status');
  await picker.selectOption('alex-one');
  await recipientRead.promise;
  await page.getByRole('heading', { name: 'Alex One’s saved school update', exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await input.isDisabled(), true, 'a stalled settings request cannot hide the school report');
  releaseRecipients.resolve();
  await page.getByRole('heading', { name: 'Report recipients for Alex One', exact: true }).waitFor();
  await input.fill('child+school@example.com, partner@example.net\nCHILD+SCHOOL@example.com');
  await save.click();
  await status.getByText('Recipients saved. Email delivery is not enabled yet.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'child+school@example.com\npartner@example.net');
  assert.match(await page.locator('#recipient-delivery').innerText(), /not enabled/);
  // A normal report refresh must not wipe unsaved settings edits.
  await input.fill('draft@example.org');
  await page.getByRole('button', { name: 'Refresh saved report', exact: true }).click();
  await page.getByRole('heading', { name: 'Alex One’s saved school update', exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'draft@example.org');
  await page.getByRole('button', { name: 'Reload saved list', exact: true }).click();
  await status.getByText('Saved recipients loaded.', { exact: true }).waitFor();
  // A delayed save for the first child must never update the second child's form.
  await input.fill('updated-child@example.com');
  savedSignal = Promise.withResolvers(); releaseSave = Promise.withResolvers(); delayNextSave = true;
  await save.click(); await savedSignal.promise;
  await picker.selectOption('alex-two');
  await page.getByRole('heading', { name: 'Report recipients for Alex Two', exact: true }).waitFor();
  await status.getByText('No recipients saved for this child.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  releaseSave.resolve();
  await input.fill('other-child@example.com'); await save.click();
  await status.getByText('Recipients saved. Email delivery is not enabled yet.', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT recipients FROM pilot_report_recipients WHERE child_id=?').get('alex-one').recipients), ['updated-child@example.com']);
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT recipients FROM pilot_report_recipients WHERE child_id=?').get('alex-two').recipients), ['other-child@example.com']);
  await input.fill('not an email'); await save.click();
  await status.getByText('Check each email address. Use addresses only, without names or extra text.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'not an email');
  await input.fill(''); await save.click();
  await status.getByText('Recipients saved. Email delivery is not enabled yet.', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT recipients FROM pilot_report_recipients WHERE child_id=?').get('alex-two').recipients), []);
  await page.reload();
  await page.getByRole('heading', { name: 'Report recipients for Alex Two', exact: true }).waitFor();
  await status.getByText('No recipients saved for this child.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const preview = await mkdtemp(join(tmpdir(), 'report-recipients-preview-'));
  await page.screenshot({ path: `${preview}/phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await picker.selectOption('alex-one');
  await status.getByText('Saved recipients loaded.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'updated-child@example.com');
  // Another window saves first: preserve editable draft text and require reload.
  sqlite.prepare('UPDATE pilot_report_recipients SET revision=?,recipients=? WHERE child_id=?')
    .run(crypto.randomUUID(), JSON.stringify(['fresh@example.com']), 'alex-one');
  await input.fill('unsaved-draft@example.com'); await save.click();
  await status.getByText('This saved list changed in another window. Keep a copy of your edits, then reload the saved list before saving again.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'unsaved-draft@example.com');
  assert.equal(await input.isEnabled(), true); assert.equal(await save.isDisabled(), true);
  await page.getByRole('button', { name: 'Reload saved list', exact: true }).click();
  await status.getByText('Saved recipients loaded.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'fresh@example.com');
  await page.screenshot({ path: `${preview}/desktop.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Recipient UI passed: private per-child lists, address validation, saved edits, clearing, child-switch races, phone and desktop. Preview: ${preview}`);
} finally { await browser.close(); }
