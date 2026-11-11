import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

export async function acquireBrowserRun(allowedDomains, keepAlive = 60000) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert(token, 'cloudflare_token_required');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || (() => {
    const { accounts } = JSON.parse(execFileSync('cf', ['auth', 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(accounts?.length, 1, 'cloudflare_account_selection_required');
    return accounts[0].id;
  })();
  assert.match(account, /^[a-f0-9]{32}$/i);
  const endpoint = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/devtools/browser`);
  const headers = { Authorization: `Bearer ${token}` };
  const acquisition = new URL(endpoint);
  acquisition.search = new URLSearchParams({ keep_alive: keepAlive, recording: false });
  const response = await fetch(acquisition, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ guardrails: { allowedDomains } }),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `browser_run_acquire_http_${response.status}`);
  const { sessionId } = await response.json();
  assert.match(sessionId, /^[a-f0-9-]{36}$/i);
  endpoint.pathname += `/${sessionId}`;
  const close = async () => {
    const result = await fetch(endpoint, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) });
    assert(result.ok, `browser_run_close_http_${result.status}`);
    assert(['closing', 'closed'].includes((await result.json()).status), 'browser_run_close_unverified');
  };
  const websocket = new URL(endpoint);
  websocket.protocol = 'wss:';
  return {
    connect: () => chromium.connectOverCDP(websocket.href, { headers, timeout: 15000 }),
    close,
  };
}

