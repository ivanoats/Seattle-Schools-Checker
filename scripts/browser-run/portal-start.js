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
