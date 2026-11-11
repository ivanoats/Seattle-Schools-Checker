import { chromium } from 'playwright';
import { sites } from '../../src/auth.js';

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const response = await page.goto(sites.source.start, {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  const sameOrigin = new URL(page.url()).origin === sites.source.origin;
  const status = response?.status() ?? null;
  let result = 'login_page_unverified';
  let supportId;
  if (sameOrigin) {
    const accountField = page.locator('#fieldAccount');
    await accountField.waitFor({ timeout: 5000 }).catch(() => {});
    if ((await page.title()).trim() === 'Request Rejected') {
      result = 'portal_request_rejected';
      supportId = (await page.locator('body').innerText()).match(/support ID is[:\s]+([\d-]+)/i)?.[1];
    } else if (response?.ok() && await accountField.isVisible() &&
        await page.locator('input[type="password"]:visible').first().isVisible()) {
      result = 'login_form_reached';
    }
  }
  console.log(JSON.stringify({ result, httpStatus: status, supportId }));
  if (result !== 'login_form_reached') process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ result: 'browser_or_navigation_failed', timeout: error.name === 'TimeoutError' }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
