import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAssignmentLookup } from '../src/source-assignment-lookup.js';
const frame = {};
const origin = 'https://ps.seattleschools.org';
const page = { url: () => `${origin}/guardian/scores.html`, mainFrame: () => frame };
function request(overrides = {}, body = { section_ids: [123], student_ids: [456], start_date: '2026-09-02', end_date: '2027-01-29' }) {
  return { url: () => `${origin}/ws/xte/assignment/lookup?_=1795050000000`, method: () => 'POST',
    frame: () => frame, resourceType: () => 'xhr', isNavigationRequest: () => false,
    headers: () => ({ referer: page.url(), 'content-type': 'application/json;charset=UTF-8' }),
    postData: () => JSON.stringify(body), postDataJSON: () => body, ...overrides };
}
test('only the rendered guardian assignment lookup may use a read POST', () => {
  assert.equal(sourceAssignmentLookup(page, request()), true);
  assert.equal(sourceAssignmentLookup(page, request({}, { section_ids: ['123'], student_ids: ['456'], start_date: '09/02/2026', end_date: '01/29/2027' })), true);
  for (const overrides of [
    { method: () => 'PUT' }, { isNavigationRequest: () => true }, { resourceType: () => 'fetch' }, { frame: () => ({}) },
    { url: () => `${origin}/ws/xte/assignment/update` }, { url: () => 'https://bad.example/ws/xte/assignment/lookup' },
    { url: () => `${origin}/ws/xte/assignment/lookup?action=update` },
    { headers: () => ({ referer: 'https://bad.example/guardian/scores.html', 'content-type': 'application/json' }) },
    { postData: () => 'x'.repeat(5000) },
  ]) assert.equal(sourceAssignmentLookup(page, request(overrides)), false);
  assert.equal(sourceAssignmentLookup({ ...page, url: () => `${origin}/public/` }, request()), false);
  for (const body of [null, [], { username: 'parent@example.com', password: 'synthetic' },
    { section_ids: [1], student_ids: [2,3], start_date: '2026-09-02', end_date: '2027-01-29' },
    { section_ids: [1], student_ids: [2], start_date: '2026-09-02', end_date: '2027-01-29', action: 'update' },
    { section_ids: [1], student_ids: [2], start_date: 'invalid', end_date: 'invalid' }]) {
    assert.equal(sourceAssignmentLookup(page, request({}, body)), false);
  }
});

test('a real Chrome XHR from the score page satisfies the read-only lookup guard', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const tab = await browser.newPage(); let allowed = false;
    await tab.route('https://ps.seattleschools.org/**', route => {
      const browserRequest = route.request();
      if (browserRequest.method() === 'POST') {
        allowed = sourceAssignmentLookup(tab, browserRequest);
        return allowed ? route.fulfill({ contentType: 'application/json', body: '[]' }) : route.abort();
      }
      return route.fulfill({ contentType: 'text/html', body: `<h1>Class Score Detail: One, Alex</h1><p id="result"></p>
        <script>const lookup=new XMLHttpRequest();lookup.open('POST','/ws/xte/assignment/lookup');lookup.setRequestHeader('Content-Type','application/json;charset=UTF-8');
        lookup.onload=()=>document.getElementById('result').textContent='Loaded';
        lookup.send(JSON.stringify({section_ids:[123],student_ids:[456],start_date:'2026-09-02',end_date:'2027-01-29'}));</script>` });
    });
    await tab.goto(`${origin}/guardian/scores.html`);
    await tab.getByText('Loaded', { exact: true }).waitFor();
    assert.equal(allowed, true);
  } finally { await browser.close(); }
});
