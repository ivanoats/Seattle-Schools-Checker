export const sites = Object.freeze({
  source: { origin: 'https://ps.seattleschools.org', start: 'https://ps.seattleschools.org/public/' },
  sugarmate: { origin: 'https://app.sugarmate.io', start: 'https://app.sugarmate.io/home' },
});
export class CheckError extends Error {
  constructor(status) { super(status); this.status = status; }
}
export function allowedCredentialDestination(service, url) {
  const u = new URL(url);
  return u.protocol === 'https:' && (service === 'source'
    ? u.origin === sites.source.origin
    : u.origin === 'https://api.sugarmate.io' && u.pathname === '/oauth/token');
}
export async function guardLoginRequest(route, service) {
  const request = route.request(), url = new URL(request.url());
  if (['GET','HEAD'].includes(request.method())) {
    const allowedRead = url.origin === sites[service].origin || (service === 'sugarmate' && url.origin === 'https://api.sugarmate.io');
    if (!allowedRead) { await route.abort(); return false; }
    await route.fallback(); return true;
  }
  if (!allowedCredentialDestination(service, request.url())) { await route.abort(); return false; }
  // Inspect redirects before Chromium can replay a password-bearing POST.
  const response = await route.fetch({ maxRedirects:0, timeout:15000 });
  const status = response.status(), location = response.headers().location;
  if (status >= 300 && status < 400) {
    if (![302,303].includes(status) || !location || new URL(location,url).origin !== sites[service].origin) {
      await route.abort(); return false;
    }
    await route.fulfill({ response, status:303 });
  } else { await route.fulfill({ response }); }
  return true;
}
export async function isSignedIn(page, service) {
  if (new URL(page.url()).origin !== sites[service].origin) return false;
  return service === 'source'
    ? /\/guardian\//.test(new URL(page.url()).pathname)
      && await page.locator('#btnLogout').isVisible()
      && !await page.getByText('You have been signed out.', { exact: true }).isVisible()
    : await page.locator('#profile').isVisible() && await page.locator('#graph').isVisible();
}
export async function ensureLogin(page, service, credentials, timeoutMs = 15000) {
  await page.goto(sites[service].start, { waitUntil: 'domcontentloaded' });
  if (service === 'source') {
    // PowerSchool can serve the public login URL even with a valid guardian session.
    if (!await page.locator('#fieldAccount').isVisible()) {
      if (await isSignedIn(page, service)) return;
    } else {
      await page.goto(sites.source.origin + '/guardian/home.html');
      if (await isSignedIn(page, service)) return;
    }
  } else {
    await page.locator('#graph, #country-of-residence-select, #user-email-input, #sign-in-button').first().waitFor();
    if (await isSignedIn(page, service)) return;
    if (await page.locator('#country-of-residence-select').isVisible()) {
      await page.locator('#country-of-residence-select option[value="US"]').waitFor({ state: 'attached' });
      await page.locator('#country-of-residence-select').selectOption('US');
    }
    if (await page.locator('#sign-in-button').isVisible()) await page.locator('#sign-in-button').click();
  }
  if (!credentials) throw new CheckError('credentials_required');
  const user = page.locator(service === 'source' ? '#fieldAccount' : '#user-email-input');
  const password = page.locator(service === 'source' ? 'input[type="password"]' : '#user-password-input');
  await user.waitFor({ timeout: 10000 });
  if (new URL(page.url()).origin !== sites[service].origin) throw new CheckError('unexpected_login_origin');
  const formAction = await password.evaluate(el => el.form?.action || location.href);
  if (new URL(formAction).origin !== sites[service].origin) throw new CheckError('unexpected_login_origin');
  // Only the site's own read requests and approved authentication writes are
  // allowed while credentials are in the page. Third-party telemetry is blocked.
  // Never record requests, console logs, traces, videos, or screenshots.
  let blocked = false;
  const guard = async route => {
    if (!await guardLoginRequest(route,service)) blocked = true;
  };
  await page.context().route('**/*', guard);
  try {
    await user.fill(credentials.username);
    await password.fill(credentials.password);
    await page.locator(service === 'source' ? '#btn-enter-sign-in' : 'input[type="submit"]').click();
    try {
      await page.waitForURL(service === 'source' ? '**/guardian/**' : '**/home', { timeout: timeoutMs });
      await page.locator(service === 'source' ? '#btnLogout' : '#graph').waitFor({ timeout: 10000 });
    } catch { throw new CheckError(blocked ? 'blocked_credential_destination' : 'sign_in_needs_attention'); }
    if (!await isSignedIn(page, service)) throw new CheckError('sign_in_needs_attention');
  } finally {
    await page.context().unroute('**/*', guard);
  }
}
