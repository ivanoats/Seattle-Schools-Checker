import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLoginGuard, loginRequestAction } from '../scripts/browser-run/schoology-login.js';

const login = 'https://app.schoology.com/login';
const request = (method, url) => ({ request: { method, url } });
const response = (status, ...locations) => ({ ...request('POST', login), responseStatusCode: status,
  responseHeaders: locations.map(value => ({ name: 'Location', value })) });

test('reads are limited to Schoology and its asset path', () => {
  assert.equal(loginRequestAction(request('GET', 'https://app.schoology.com/parent/home'), false), 'continue_read');
  assert.equal(loginRequestAction(request('GET', 'https://asset-cdn.schoology.com/assets/app.js'), false), 'continue_read');
  assert.equal(loginRequestAction(request('GET', 'https://asset-cdn.schoology.com/other/app.js'), false), 'block_read');
  assert.equal(loginRequestAction(request('HEAD', 'https://telemetry.invalid/collect'), false), 'block_read');
});

test('the login POST is allowed once and only to the login endpoint', () => {
  assert.equal(loginRequestAction(request('POST', login), false), 'continue_login');
  assert.equal(loginRequestAction(request('POST', login), true), 'blocked_login_retry');
  assert.equal(loginRequestAction(request('POST', 'https://app.schoology.com/other'), false), 'blocked_credential_destination');
  assert.equal(loginRequestAction(request('POST', 'https://outside.invalid/login'), false), 'blocked_credential_destination');
  assert.equal(loginRequestAction(request('PUT', login), false), 'blocked_credential_destination');
});

test('only a single same-origin 302 or 303 redirect may follow the login', () => {
  assert.equal(loginRequestAction(response(200), true), 'continue_response');
  assert.equal(loginRequestAction(response(302, '/parent/home'), true), 'continue_response');
  assert.equal(loginRequestAction(response(303, 'https://app.schoology.com/home'), true), 'continue_response');
  assert.equal(loginRequestAction(response(302, 'https://outside.invalid/collect'), true), 'blocked_login_redirect');
  assert.equal(loginRequestAction(response(307, '/parent/home'), true), 'blocked_login_redirect');
  assert.equal(loginRequestAction(response(308, '/parent/home'), true), 'blocked_login_redirect');
  assert.equal(loginRequestAction(response(302), true), 'blocked_login_redirect');
  assert.equal(loginRequestAction(response(302, '/a', '/b'), true), 'blocked_login_redirect');
  assert.equal(loginRequestAction({ ...request('POST', login), responseErrorReason: 'Failed' }, true), 'network_error');
});

function fakeCdp(failing = []) {
  const sent = [];
  const handlers = new Map();
  return { sent, handlers,
    on: (name, handler) => handlers.set(name, handler),
    off: (name, handler) => { if (handlers.get(name) === handler) handlers.delete(name); },
    send: async (method, params) => {
      sent.push([method, params]);
      if (failing.includes(method)) throw new Error('cdp_failed');
    },
    pause: event => handlers.get('Fetch.requestPaused')(event) };
}

test('the guard continues one login, records its status and blocks a retry', async () => {
  const cdp = fakeCdp();
  const guard = await installLoginGuard(cdp);
  await cdp.pause({ requestId: 'read', ...request('GET', 'https://app.schoology.com/login') });
  await cdp.pause({ requestId: 'post', ...request('POST', login) });
  await cdp.pause({ requestId: 'post', ...response(302, '/parent/home') });
  assert.deepEqual(guard.result(), { posted: true, httpStatus: 302, failure: null });
  await cdp.pause({ requestId: 'again', ...request('POST', login) });
  assert.equal(guard.result().failure, 'blocked_login_retry');
  assert.deepEqual(cdp.sent.slice(1), [
    ['Fetch.continueRequest', { requestId: 'read' }],
    ['Fetch.continueRequest', { requestId: 'post', interceptResponse: true }],
    ['Fetch.continueResponse', { requestId: 'post' }],
    ['Fetch.failRequest', { requestId: 'again', errorReason: 'BlockedByClient' }],
  ]);
  await guard.close();
  assert.deepEqual(cdp.sent.at(-1), ['Fetch.disable', undefined]);
  assert.equal(cdp.handlers.size, 0);
});

test('blocked reads fail quietly and unsafe redirects fail the login', async () => {
  const cdp = fakeCdp();
  const guard = await installLoginGuard(cdp);
  await cdp.pause({ requestId: 'ad', ...request('GET', 'https://telemetry.invalid/pixel') });
  assert.equal(guard.result().failure, null);
  await cdp.pause({ requestId: 'post', ...response(302, 'https://outside.invalid/collect') });
  assert.equal(guard.result().failure, 'blocked_login_redirect');
  assert.deepEqual(cdp.sent.at(-1), ['Fetch.failRequest', { requestId: 'post', errorReason: 'BlockedByClient' }]);
});

test('a failed browser command blocks the request and fails the login', async () => {
  const cdp = fakeCdp(['Fetch.continueRequest']);
  const guard = await installLoginGuard(cdp);
  await cdp.pause({ requestId: 'post', ...request('POST', login) });
  assert.equal(guard.result().failure, 'login_guard_failed');
  assert.deepEqual(cdp.sent.at(-1), ['Fetch.failRequest', { requestId: 'post', errorReason: 'BlockedByClient' }]);
});

test('the guard is removed when interception cannot be enabled', async () => {
  const cdp = fakeCdp(['Fetch.enable']);
  await assert.rejects(installLoginGuard(cdp), { status: 'login_guard_unavailable' });
  assert.equal(cdp.handlers.size, 0);
});
