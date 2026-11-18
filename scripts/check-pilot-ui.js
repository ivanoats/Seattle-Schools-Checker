// Synthetic browser checks only. No real portal or account is contacted.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import worker from '../src/cloudflare/worker.js';
import { buildFamilyReport } from '../src/core/family-report.js';

const origin = 'https://pilot.example';
const now = '2026-11-18T19:00:00.000Z';
const source = childId => ({ version: 1, childId, provider: 'source', term: 's1', observedAt: now,
  courses: [{ course: 'French', semester: 'C', missing: [{ assignment: 'Verb practice', due: '11/17/2026', score: '2/5' }], rows: [] },
    { course: 'Support', semester: 'Unavailable', missing: null, rows: null }],
  attendance: { absences: [{ date: '2026-11-17', period: '1', code: 'ME' }], tardies: [] } });
const item = { assignment: 'Essay', course: 'Literature', url: 'https://app.schoology.com/assignment/123',
  submissionStatus: 'This material has been submitted but not yet graded' };
const schoology = childId => ({ version: 1, childId, provider: 'schoology', observedAt: now,
  overdue: [item], recentlyCompleted: [item], upcoming: [], events: [] });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  let selected = null; let mode = 'normal'; let selections = 0;
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'the app must not load third-party resources');
    if (!url.pathname.startsWith('/api/')) {
      const response = await worker.fetch(new Request(url.href), {});
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    let status = 200; let data;
    if (mode === 'expired') { status = 401; data = { status: 'sign_in_required' }; }
    else if (url.pathname.endsWith('/session')) data = { status: 'ok', email: 'parent@example.com', selectedChildId: selected, connectionsAvailable: false };
    else if (url.pathname.endsWith('/children')) data = { status: 'ok', children: mode === 'empty' ? [] : [
      { id: 'alex-one', displayName: 'Alex One' }, { id: 'alex-two', displayName: 'Alex Two' }] };
    else if (url.pathname.endsWith('/selection')) { selected = request.postDataJSON().childId; selections++; data = { status: 'selected' }; }
    else if (url.pathname.endsWith('/report')) {
      const childId = url.searchParams.get('childId');
      data = { status: 'ok', child: { id: childId, displayName: childId === 'alex-one' ? 'Alex One' : 'Alex Two' },
        providers: [{ provider: 'source', lastStatus: 'unavailable', observedAt: now, lastAttemptAt: now },
          { provider: 'schoology', lastStatus: 'ok', observedAt: now, lastAttemptAt: now }],
        report: buildFamilyReport({ childId, source: source(childId), schoology: schoology(childId), cutoff: now }) };
    } else { status = 404; data = { status: 'not_found' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(origin + '/app');
  await page.getByLabel('Whose week are we looking at?').selectOption('alex-one');
  await page.getByRole('heading', { name: 'Alex One’s saved school update' }).waitFor();
  assert.match(await page.locator('#report').innerText(), /Unknown/);
  assert.match(await page.locator('#report').innerText(), /latest check did not succeed/);
  assert.match(await page.locator('#report').innerText(), /Submitted; Schoology also lists this overdue/);
  assert.equal(await page.getByRole('textbox').count(), 0, 'no password entry before connections are implemented');
  await page.getByLabel('Whose week are we looking at?').selectOption('alex-two');
  await page.getByRole('heading', { name: 'Alex Two’s saved school update' }).waitFor();
  assert.doesNotMatch(await page.locator('#report').innerText(), /Alex One/);
  assert.equal(selections, 2);
  await page.reload();
  await page.getByRole('heading', { name: 'Alex Two’s saved school update' }).waitFor();
  assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth), true);
  const screenshots = process.env.PILOT_SCREENSHOT_DIR || '/private/tmp/seattle-schools-pilot-preview';
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: screenshots + '/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: screenshots + '/desktop.png', fullPage: true });
  mode = 'empty'; await page.reload();
  await page.getByText('Your family account is ready. School connections must be enabled before children can be discovered.').waitFor();
  mode = 'expired'; await page.reload();
  await page.getByText('Your sign-in has expired. Open the app again to receive a new login code.').waitFor();
  assert.deepEqual(errors, []);
  console.log('Pilot UI passed: phone/desktop, child switching, saved selection, stale data, submission conflict, empty account and expired sign-in. Synthetic data only.');
} finally { await browser.close(); }
