import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectAccount } from '../src/collect-account.js';

const children = ['One', 'Two'].map((surname, index) => ({ id: `child-${index}`, displayName: `Alex ${surname}`,
  providers: { source: { tabLabel: 'Alex', studentHeading: `${surname}, Alex`, tabHref: `/guardian/home.html?student=${index + 1}` },
    schoology: { banner: `You are viewing as Alex ${surname}`, selectionHref: `/parent/switch_child/${index + 1}` } } }));

// A real isolated browser exercises authenticated session setup and both portal
// extractors against rendered synthetic pages; no school credentials are used.
async function launchFixture(provider) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (provider === 'source' && url.pathname === '/public/') return route.fulfill({ status: 302, headers: { Location: '/guardian/home.html' } });
      const number = url.searchParams.get('student') ?? url.pathname.match(/switch_child\/(\d+)/)?.[1] ?? '1';
      const child = children[Number(number) - 1];
      const name = child.providers.source.studentHeading;
      let body = '';
      if (provider === 'schoology') body = `<div id="child-session-banner">${child.providers.schoology.banner}</div>
        <div id="right-column-inner"><div id="overdue-submissions"><div class="upcoming-event">
        <span class="event-title"><a href="/assignment/123">${child.displayName} outline</a></span></div></div></div>`;
      else if (url.pathname.endsWith('attendance.html')) body = `<h1>Attendance: ${name}</h1><div id="content-main">1 - 11/18/2026 - EA</div>`;
      else if (url.pathname.endsWith('detail.html')) body = `<h1>Class Score Detail: ${name}</h1><table><tbody role="grid">
        <tr id="assignmentsection_1"><td>11/18/2026</td><td></td><td>${child.displayName} outline</td><td class="score">5/10</td>
        <td><span class="tt-missing"></span></td></tr></tbody></table>`;
      else {
        const cells = Array(20).fill(''); cells[0] = '1'; cells[11] = 'French';
        cells[14] = `<a href="/guardian/detail.html?student=${number}">B</a>`;
        body = `<button id="btnLogout">Sign out</button><a href="${children[0].providers.source.tabHref}">Alex</a>
          <a href="${children[1].providers.source.tabHref}">Alex</a><h1>Grades: ${name}</h1>
          <table id="tblgrades"><tr id="course-1">${cells.map(cell => `<td>${cell}</td>`).join('')}</tr></table>
          <div id="tblgrades"><a href="/guardian/attendance.html?codes=*abs&student=${number}">Absences</a>
          <a href="/guardian/attendance.html?codes=*tar&student=${number}">Tardies</a></div>`;
      }
      return route.fulfill({ contentType: 'text/html', body });
      });
      return page;
    };
    return context;
  };
  return browser;
}

test('hosted collection reads two confirmed children through each guarded portal and clears credentials', async () => {
  for (const provider of ['source', 'schoology']) {
    const credentials = { username: 'parent@example.com', password: 'synthetic-password' };
    const output = await collectAccount(provider, credentials, children, () => launchFixture(provider));
    assert.equal(output.status, 'ok', JSON.stringify(output)); assert.equal(output.results.length, 2);
    assert.deepEqual(credentials, { username: '', password: '' });
    for (const [index, result] of output.results.entries()) {
      assert.equal(result.status, 'ok'); assert.equal(result.observation.childId, children[index].id);
      if (provider === 'source') {
        assert.equal(result.observation.courses[0].missing[0].assignment, `${children[index].displayName} outline`);
        assert.equal(result.observation.courses[0].rows[0].missing, true);
      } else {
        assert.equal(result.observation.overdue[0].assignment, `${children[index].displayName} outline`);
        assert.equal(result.observation.upcoming, null);
      }
    }
  }
});

test('a later child timeout preserves the first verified observation', async () => {
  let pending = null;
  const browser = { close: () => { pending?.reject(new Error('Browser closed')); return Promise.resolve(); },
    newContext: () => Promise.resolve({ close: () => Promise.resolve(), route: () => Promise.resolve(),
      newPage: () => Promise.resolve({ setDefaultTimeout(value) { assert.equal(value, 10000); }, goto: () => Promise.resolve(),
        url: () => 'https://app.schoology.com/parent/home', locator: selector => ({
          isVisible: () => Promise.resolve(selector === '#child-session-banner'),
        }) }) }) };
  const output = await collectAccount('schoology', { username: 'parent@example.com', password: 'synthetic' }, children,
    () => Promise.resolve(browser), { timeoutMs: 20, readers: { schoology: (page, child) => {
      if (child.id === children[0].id) return Promise.resolve({ student: child.displayName,
        overdue: null, upcoming: [], events: [], recentlyCompleted: [], overdueCoverage: 'unavailable' });
      pending = Promise.withResolvers(); return pending.promise;
    } } });
  assert.equal(output.status, 'ok'); assert.equal(output.results[0].status, 'ok');
  assert.equal(output.results[1].reason, 'check_expired');
});

test('a Source heading mismatch has an explicit identity-failure status', async () => {
  const { readSource } = await import('../src/source.js');
  const browser = await launchFixture('source');
  try {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(1000);
    const child = structuredClone(children[0]); child.providers.source.studentHeading = 'Different, Child';
    await assert.rejects(readSource(page, child), { status: 'source_child_identity_unverified' });
  } finally { await browser.close(); }
});
