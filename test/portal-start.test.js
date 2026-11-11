import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPortalStart } from '../scripts/browser-run/portal-start.js';

const page = overrides => ({ title: 'Parent Sign In', bodyText: '', sameOrigin: true,
  ok: true, loginForm: true, ...overrides });

test('a visible same-origin login form is the only success', () => {
  assert.deepEqual(classifyPortalStart(page()), { result: 'login_form_reached' });
  assert.equal(classifyPortalStart(page({ loginForm: false })).result, 'login_page_unverified');
  assert.equal(classifyPortalStart(page({ ok: false })).result, 'login_page_unverified');
  assert.equal(classifyPortalStart(page({ sameOrigin: false })).result, 'login_page_unverified');
});

test('a firewall rejection is reported with its support ID despite HTTP 200', () => {
  assert.deepEqual(classifyPortalStart(page({ title: ' Request Rejected ', loginForm: false,
    bodyText: 'The requested URL was rejected. Your support ID is: 1234567890123456789' })),
  { result: 'portal_request_rejected', supportId: '1234567890123456789' });
  assert.deepEqual(classifyPortalStart(page({ title: 'Request Rejected', bodyText: '' })),
    { result: 'portal_request_rejected' });
});

test('an access-session failure is distinct from a firewall rejection', () => {
  assert.equal(classifyPortalStart(page({ title: 'BIG-IP logout page', loginForm: false,
    bodyText: 'Your session could not be established.' })).result, 'portal_session_not_established');
  assert.equal(classifyPortalStart(page({ title: '', loginForm: false,
    bodyText: 'Your session could not be established.' })).result, 'portal_session_not_established');
});
