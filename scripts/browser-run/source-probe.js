import { chromium } from 'playwright';
import { sites } from '../../src/auth.js';
import { classifyPortalStart } from './portal-start.js';

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
  const sameOrigin = new URL(page.url()).origin === sites.source.origin;
  const accountField = page.locator('#fieldAccount');
  if (sameOrigin) await accountField.waitFor({ timeout: 5000 }).catch(() => null);
  const outcome = classifyPortalStart({
    title: await page.title(),
    bodyText: sameOrigin ? await page.locator('body').innerText() : '',
    sameOrigin,
    ok: response?.ok() ?? false,
    loginForm: sameOrigin && await accountField.isVisible() &&
      await page.locator('input[type="password"]:visible').first().isVisible(),
  });
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
