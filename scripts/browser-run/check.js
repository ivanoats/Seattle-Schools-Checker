import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { ensureLogin, sites } from '../../src/auth.js';
import { readSchoology, verifySchoologyChild } from '../../src/schoology.js';
import { readSource } from '../../src/source.js';
import { children, credentials, fixturePage, forms } from './fixtures.js';
import { acquireBrowserRun } from './session.js';

const local = process.argv[2] === '--local';
const started = performance.now();
let stage = 'setup';
let browser = null;
let closeCloudSession = null;
let server = null;
const verified = [];

// The intercepted POST uses Playwright's real route.fetch against loopback.
// Chromium receives the resulting redirect through the production login guard.
async function startRedirectServer() {
  const requests = [];
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const service = url.searchParams.get('service');
    const scenario = url.searchParams.get('scenario');
    requests.push({ method: req.method, fields });
    const destination = scenario === 'cross-origin' ? 'https://outside.invalid/collect' :
      sites[service].origin + forms[service].landing;
    res.writeHead(scenario === 'replay' ? 307 : 302, { Location: destination, 'Content-Length': 0 });
    res.end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/redirect` };
}

// Swap only the upstream URL used by route.fetch. Keep Playwright's real
// interception, request data, redirect handling, and response fulfillment.
function loginPage(page, context, redirectURL, onPost, onRedirect) {
  const wrappers = new Map();
  return {
    url: page.url.bind(page), goto: page.goto.bind(page), locator: page.locator.bind(page),
    getByText: page.getByText.bind(page), getByRole: page.getByRole.bind(page),
    waitForURL: page.waitForURL.bind(page), waitForLoadState: page.waitForLoadState.bind(page),
    context: () => ({
      route(pattern, handler) {
        const wrapped = route => handler({
          request: () => route.request(),
          abort: () => route.abort(),
          fallback: () => route.fallback(),
          fulfill: async options => {
            if (options.status !== 303) return route.fulfill(options);
            const location = options.response.headers().location;
            onRedirect(options.status, location);
            // Playwright only routes the first URL in a redirect chain.
            // Start a fresh GET so the synthetic landing stays intercepted.
            return route.fulfill({ contentType: 'text/html', body:
              `<script>location.replace(${JSON.stringify(location)})</script>` });
          },
          fetch: options => {
            onPost();
            return route.fetch({ ...options, url: redirectURL });
          },
        });
        wrappers.set(handler, wrapped);
        return context.route(pattern, wrapped);
      },
      unroute: (pattern, handler) => context.unroute(pattern, wrappers.get(handler)),
    }),
  };
}

async function runScenario(service, child, scenario, redirect) {
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  let signedIn = false;
  let postSeen = false;
  let landingGet = false;
  const unmatched = [];
  const approvedRedirects = [];
  const start = redirect.requests.length;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (postSeen && scenario === 'safe' && url.origin === sites[service].origin &&
        url.pathname === forms[service].landing && request.method() === 'GET') {
      signedIn = true;
      landingGet = true;
    }
    const body = fixturePage(service, child, url, signedIn);
    if (request.method() !== 'GET' || body === null) {
      unmatched.push(request.method());
      await route.abort();
      return;
    }
    await route.fulfill({ contentType: 'text/html', body });
  });
  const url = new URL(redirect.url);
  url.search = new URLSearchParams({ service, scenario });
  const guardedPage = loginPage(page, context, url.href, () => { postSeen = true; },
    (status, location) => approvedRedirects.push([status, location]));
  if (scenario === 'safe') {
    await ensureLogin(guardedPage, service, credentials, 3500);
    assert.equal(landingGet, true);
    assert.deepEqual(approvedRedirects, [[303, sites[service].origin + forms[service].landing]]);
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      'America/Los_Angeles');
    if (service === 'source') {
      const report = await readSource(page, child);
      assert.equal(report.student, child.displayName);
      assert.deepEqual(report.courses[0].missing.map(item => [item.assignment, item.score]),
        [['Shared title', child === children[0] ? '5/10' : '8/10']]);
      assert.deepEqual(report.absences, [{ period: '1', date: '2026-11-05', code: 'A' }]);
      assert.deepEqual(report.tardies, [{ period: '1', date: '2026-11-06', code: 'L' }]);
    } else {
      const report = await readSchoology(page, child);
      assert.equal(report.student, child.displayName);
      assert.equal(report.overdueCoverage, 'expanded_visible_list');
      assert.deepEqual(report.overdue.map(item => item.description), [`Shared title ${child.id}`]);
      assert.equal(report.upcoming[0].assignment, 'Future work');
      assert.match(report.recentlyCompleted[0].submissionStatus, /submitted but not yet graded/);
      const other = children.find(candidate => candidate !== child);
      await assert.rejects(verifySchoologyChild(page, other, 700), { status: 'schoology_select_child_required' });
    }
  } else {
    await assert.rejects(ensureLogin(guardedPage, service, credentials, 750),
      { status: 'blocked_credential_destination' });
    assert.equal(landingGet, false);
    assert.deepEqual(approvedRedirects, []);
  }
  assert.deepEqual(redirect.requests.slice(start), [{ method: 'POST', fields: credentials }]);
  assert.deepEqual(unmatched, []);
}

try {
  stage = 'redirect_fixture';
  const redirect = await startRedirectServer();
  stage = 'browser_acquisition';
  if (local) {
    browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  } else {
    const session = await acquireBrowserRun([]);
    closeCloudSession = session.close;
    browser = await session.connect();
  }
  const chromeVersion = browser.version();
  if (!local) {
    stage = 'browser_egress_guardrail';
    const page = await browser.contexts()[0].newPage();
    const blocked = await page.goto('https://example.org/', { timeout: 10000 });
    assert.equal(blocked.status(), 403);
    assert.equal(blocked.headers()['cf-mitigated'], 'guardrails');
    verified.push(stage);
  }
  for (const service of ['source', 'schoology']) {
    for (const [child, scenario] of [[children[0], 'safe'], [children[1], 'safe'],
      [children[0], 'cross-origin'], [children[0], 'replay']]) {
      stage = `${service}/${child.id}/${scenario}`;
      await runScenario(service, child, scenario, redirect);
      verified.push(stage);
      if (process.env.BROWSER_RUN_DEBUG === '1') console.error(stage, Math.round(performance.now() - started));
    }
  }
  stage = 'browser_cleanup';
  await browser.close();
  browser = null;
  if (closeCloudSession) {
    await closeCloudSession();
    closeCloudSession = null;
  }
  process.stdout.write(`${JSON.stringify({ status: 'ok', browser: local ? 'local Chrome' : 'Cloudflare Browser Run',
    chromeVersion, verified, elapsedSeconds: Math.round((performance.now() - started) / 100) / 10 })}\n`);
} catch (error) {
  if (process.env.BROWSER_RUN_DEBUG === '1') {
    console.error(error.message.split('\n')[0]
      .replace(/(?:https?|wss?):\/\/\S+/g, '[url]')
      .replace(/\b[0-9a-f-]{32,}\b/gi, '[id]'));
  }
  const detail = /^(browser_run_(?:acquire|close)_http_\d+|cloudflare_(?:token|account_selection)_required)$/.test(error.message)
    ? error.message : error.status || error.name;
  console.error(JSON.stringify({ status: 'failed', stage, detail, verified }));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally {
    try { await closeCloudSession?.(); } catch {
      console.error('Cloudflare did not confirm session cleanup. The session has a short idle timeout.');
      process.exitCode = 1;
    } finally { server?.close(); }
  }
}
