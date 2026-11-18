import { claimDiscovery, completeDiscovery } from './connections.js';
import { discoverAccount } from '../discover-account.js';

// Called by a scheduled invocation, not HTTP waitUntil's shorter grace period.
// One claimed job per invocation bounds workload; overlapping invocations
// cannot claim the same job. No raw errors, credentials or records are logged.
export async function runSchoologyDiscovery(env, dependencies = {}) {
  let job;
  try {
    job = await claimDiscovery(env, 'schoology');
    if (!job) return { status: 'idle' };
    const launch = dependencies.launch ?? (async () => {
      const { launch: openBrowser } = await import('@cloudflare/playwright');
      return openBrowser(env.BROWSER);
    });
    const output = await discoverAccount('schoology', job.credentials, launch);
    const accepted = await completeDiscovery(env, 'schoology', job.id, job.lease, output);
    return { status: accepted ? 'recorded' : 'stale_job' };
  } catch { return { status: 'discovery_failed' }; }
  finally { if (job?.credentials) { job.credentials.username = ''; job.credentials.password = ''; } }
}
