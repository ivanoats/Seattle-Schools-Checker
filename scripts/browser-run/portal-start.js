// Classifies the first response from a portal's public sign-in URL.
// The Source sits behind an F5 BIG-IP. Its firewall rejection and its
// access-session error both return HTTP 200, so the status code alone
// cannot distinguish them from the real login form.
export function classifyPortalStart({ title = '', bodyText = '', sameOrigin, ok, loginForm }) {
  if (!sameOrigin) return { result: 'login_page_unverified' };
  if (title.trim() === 'Request Rejected') {
    const supportId = bodyText.match(/support ID is[:\s]+([\d-]+)/i)?.[1];
    return { result: 'portal_request_rejected', ...(supportId && { supportId }) };
  }
  if (/^BIG-IP\b/.test(title.trim()) || /session could not be established/i.test(bodyText)) {
    return { result: 'portal_session_not_established' };
  }
  return { result: ok && loginForm ? 'login_form_reached' : 'login_page_unverified' };
}

// Reads what the classifier needs from a page that has just loaded the
// portal's public sign-in URL.
export async function inspectPortalStart(page, response, origin) {
  const sameOrigin = new URL(page.url()).origin === origin;
  const accountField = page.locator('#fieldAccount');
  if (sameOrigin) await accountField.waitFor({ timeout: 5000 }).catch(() => null);
  return classifyPortalStart({
    title: await page.title(),
    bodyText: sameOrigin ? await page.locator('body').innerText() : '',
    sameOrigin,
    ok: response?.ok() ?? false,
    loginForm: sameOrigin && await accountField.isVisible() &&
      await page.locator('input[type="password"]:visible').first().isVisible(),
  });
}
