import { pathToFileURL } from 'node:url';
import { discoverAccount } from '../../src/discover-account.js';

export function discoveryEndpoint(value, action) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['', '/'].includes(url.pathname)) throw new Error('invalid_discovery_origin');
  return url.origin + '/v1/discovery/source/' + action;
}

export async function runSourceDiscovery({ origin, token, launch, request = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return { status: 'not_configured' };
  let job;
  try {
    const claim = await request(discoveryEndpoint(origin, 'claim'), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!claim.ok) return { status: 'claim_unavailable' };
    const data = await claim.json();
    if (data.status === 'idle') return { status: 'idle' };
    job = data.job;
    const expiry = Date.parse(job?.expiresAt);
    if (job?.provider !== 'source' || !/^[a-f0-9]{64}$/.test(job.lease ?? '') ||
        !/^[a-f0-9-]{36}$/.test(job.id ?? '') || !Number.isFinite(expiry) || expiry <= Date.now()
        || expiry > Date.now() + 150000 ||
        typeof job.credentials?.username !== 'string' || typeof job.credentials?.password !== 'string'
        ) return { status: 'invalid_job' };
    const output = await discoverAccount('source', job.credentials, launch);
    const completion = await request(discoveryEndpoint(origin, 'complete'), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, lease: job.lease, output }), signal: AbortSignal.timeout(15000) });
    return { status: completion.ok ? 'recorded' : 'completion_unverified' };
  } catch { return { status: 'discovery_failed' }; }
  finally { if (job?.credentials) { job.credentials.username = ''; job.credentials.password = ''; } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright');
  const summary = await runSourceDiscovery({ origin: process.env.DISCOVERY_APP_ORIGIN,
    token: process.env.SOURCE_DISCOVERY_TOKEN,
    launch: () => chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: process.platform === 'linux', timeout: 20000 }) });
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (!['idle', 'recorded'].includes(summary.status)) process.exitCode = 1;
}
