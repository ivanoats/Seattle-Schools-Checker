import { CheckError, allowedCredentialDestination, isSignedIn, sites } from '../../src/auth.js';

const origin = sites.schoology.origin;

export function loginRequestAction(event, alreadyPosted) {
  const { request, responseStatusCode, responseErrorReason, responseHeaders = [] } = event;
  const url = new URL(request.url);
  if (responseErrorReason) return 'network_error';
  if (responseStatusCode !== undefined) {
    if (responseStatusCode >= 300 && responseStatusCode < 400) {
      const locations = responseHeaders.filter(header => header.name.toLowerCase() === 'location');
      if (locations.length !== 1 || ![302, 303].includes(responseStatusCode) ||
          new URL(locations[0].value, url).origin !== origin) return 'blocked_login_redirect';
    }
    return 'continue_response';
  }
  if (['GET', 'HEAD'].includes(request.method)) {
    if (url.origin === origin || (url.origin === 'https://asset-cdn.schoology.com' &&
        url.pathname.startsWith('/assets/'))) return 'continue_read';
    return 'block_read';
  }
  if (request.method === 'POST' && allowedCredentialDestination('schoology', url.href)) {
    return alreadyPosted ? 'blocked_login_retry' : 'continue_login';
  }
  return 'blocked_credential_destination';
}

export async function installLoginGuard(cdp) {
  let posted = false;
  let httpStatus = null;
  let failure;
  const handler = async event => {
    const { requestId } = event;
    try {
      const action = loginRequestAction(event, posted);
      if (action === 'continue_read') {
        await cdp.send('Fetch.continueRequest', { requestId });
      } else if (action === 'continue_login') {
        posted = true;
        await cdp.send('Fetch.continueRequest', { requestId, interceptResponse: true });
      } else if (action === 'continue_response') {
        httpStatus = event.responseStatusCode;
        await cdp.send('Fetch.continueResponse', { requestId });
      } else {
        if (action !== 'block_read') failure ??= action;
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } catch {
      failure ??= 'login_guard_failed';
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  };
  cdp.on('Fetch.requestPaused', handler);
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } catch {
    cdp.off('Fetch.requestPaused', handler);
    throw new CheckError('login_guard_unavailable');
  }
  return { result: () => ({ posted, httpStatus, failure }),
    close: async () => {
      try { await cdp.send('Fetch.disable'); }
      finally { cdp.off('Fetch.requestPaused', handler); }
    } };
}

export async function signInSchoology(page, cdp, credentials) {
  const email = page.locator('#edit-mail');
  const password = page.locator('#edit-pass');
  const submit = page.locator('#edit-submit');
  await email.waitFor();
  const form = await password.evaluate(element => ({
    action: element.form?.action, method: element.form?.method,
  }));
  if (new URL(page.url()).origin !== origin || !form.action || form.method !== 'post' ||
      !allowedCredentialDestination('schoology', form.action)) {
    throw new CheckError('unexpected_login_destination');
  }
  const guard = await installLoginGuard(cdp);
  try {
    await email.fill(credentials.username);
    await password.fill(credentials.password);
    await submit.click();
    await page.waitForURL(url => url.origin === origin && !url.pathname.startsWith('/login'));
    await page.locator('#child-session-banner, a[href="/parent/calendar"], a[aria-label="Calendar"]').first().waitFor();
    if (!await isSignedIn(page, 'schoology')) throw new CheckError('sign_in_unverified');
    const { posted, httpStatus, failure } = guard.result();
    if (failure) throw new CheckError(failure);
    if (!posted || httpStatus === null) throw new CheckError('login_post_unverified');
    return httpStatus;
  } catch {
    const { httpStatus, failure } = guard.result();
    const error = new CheckError(failure || (httpStatus === 401 || httpStatus === 403
      ? 'schoology_login_denied' : 'schoology_sign_in_needs_attention'));
    error.httpStatus = httpStatus;
    throw error;
  } finally {
    await guard.close().catch(() => {});
  }
}
