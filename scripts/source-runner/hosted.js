import { pathToFileURL } from 'node:url';
import { runSourceDiscovery, discoveryEndpoint } from './discover.js';
import { collectAccount } from '../../src/collect-account.js';

export function collectionEndpoint(origin, action) {
  return discoveryEndpoint(origin, action).replace('/discovery/', '/collection/');
}

function validJob(job, now) {
  return job?.provider === 'source' && /^[a-f0-9-]{36}$/.test(job.id ?? '') && /^[a-f0-9]{64}$/.test(job.lease ?? '')
    && Date.parse(job.expiresAt) > now && Date.parse(job.expiresAt) <= now + 330000
    && Array.isArray(job.children) && job.children.length > 0 && job.children.length <= 20
    && typeof job.credentials?.username === 'string' && typeof job.credentials?.password === 'string';
}

// The same service serializes onboarding and collection. A new browser belongs
// only to the claimed family; credentials are never persisted on the host.
export async function runHostedSource({ origin, token, launch, request = fetch, discover = runSourceDiscovery, collect = collectAccount }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return { status: 'not_configured' };
  const discovery = await discover({ origin, token, launch, request });
  if (discovery.status !== 'idle') return discovery;
  let job = null;
  try {
    const claim = await request(collectionEndpoint(origin, 'claim'), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!claim.ok) return { status: 'claim_unavailable' };
    const data = await claim.json();
    if (data.status === 'idle') return { status: 'idle' };
    job = data.job;
    if (!validJob(job, Date.now())) return { status: 'invalid_job' };
    const output = await collect('source', job.credentials, job.children, launch);
    const completion = await request(collectionEndpoint(origin, 'complete'), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, lease: job.lease, output }), signal: AbortSignal.timeout(15000) });
    return { status: completion.ok ? 'recorded' : 'completion_unverified' };
  } catch { return { status: 'check_failed' }; }
  finally { if (job?.credentials) { job.credentials.username = ''; job.credentials.password = ''; } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright');
  const summary = await runHostedSource({ origin: process.env.DISCOVERY_APP_ORIGIN, token: process.env.SOURCE_DISCOVERY_TOKEN,
    launch: () => chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: process.platform === 'linux', timeout: 20000 }) });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!['idle', 'recorded'].includes(summary.status)) process.exitCode = 1;
}
