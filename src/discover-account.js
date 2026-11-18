import { CheckError, ensureLogin, isSignedIn, sites } from './auth.js';
import { discoverSourceChildren, discoverSchoologyChildren } from './portal-discovery.js';
import { consumeSourceChildSwitch } from './source-child-navigation.js';
import { signInSchoology } from '../scripts/browser-run/schoology-login.js';

// Every job owns a fresh browser/context; no family shares cookies or tabs.
// launch is supplied by the stock-Chrome host or the Browser Run Worker.
export async function discoverAccount(provider, credentials, launch, timeoutMs = 75000) {
  let browser; let context; let timer; let expired = false;
  try {
    if (!['source', 'schoology'].includes(provider)) throw new CheckError('invalid_provider');
    timer = setTimeout(() => { expired = true; browser?.close().catch(() => null); }, timeoutMs);
    browser = await launch();
    if (expired) throw new CheckError('discovery_expired');
    context = await browser.newContext({ timezoneId: 'America/Los_Angeles', locale: 'en-US',
      serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    if (provider === 'source') await ensureLogin(page, provider, credentials);
    else {
      await page.goto(sites.schoology.start, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (!await isSignedIn(page, 'schoology')) {
        await signInSchoology(page, await context.newCDPSession(page), credentials);
      }
    }
    credentials.username = ''; credentials.password = '';
    // Child discovery reads rendered pages. Source may submit only its verified,
    // single-use child-selection form; all other non-GET requests stay blocked.
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      const allowed = (provider === 'source' && consumeSourceChildSwitch(page, request)) || ['GET', 'HEAD'].includes(request.method()) && (url.origin === sites[provider].origin
        || (provider === 'schoology' && url.origin === 'https://asset-cdn.schoology.com' && url.pathname.startsWith('/assets/')));
      if (allowed) await route.continue(); else await route.abort();
    });
    const children = await (provider === 'source' ? discoverSourceChildren : discoverSchoologyChildren)(page);
    return { status: 'ok', children };
  } catch (error) {
    return { status: 'attention', reason: error instanceof CheckError && /^[a-z_]{1,64}$/.test(error.status)
      ? error.status : 'discovery_failed' };
  } finally {
    clearTimeout(timer);
    credentials.username = ''; credentials.password = '';
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
  }
}
