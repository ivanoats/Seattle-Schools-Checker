import { chromium } from 'playwright';
import { sites } from '../../src/auth.js';
import { inspectPortalStart } from './portal-start.js';

// Usage: node scripts/browser-run/source-probe.js [--headed] [--label name]
// The label names the runner in the output so results from several
// environments can be compared side by side.
const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const labelAt = args.indexOf('--label');
const label = labelAt >= 0 ? args[labelAt + 1] ?? null : null;
const client = { label, headless, channel: 'chrome', platform: process.platform };

let browser = null;
try {
  browser = await chromium.launch({ channel: 'chrome', headless, timeout: 15000 });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const response = await page.goto(sites.source.start, {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  const outcome = await inspectPortalStart(page, response, sites.source.origin);
  process.stdout.write(`${JSON.stringify({ ...outcome, httpStatus: response?.status() ?? null,
    checkedAt: new Date().toISOString(), client })}\n`);
  if (outcome.result !== 'login_form_reached') process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ result: 'browser_or_navigation_failed',
    timeout: error.name === 'TimeoutError', client })}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
