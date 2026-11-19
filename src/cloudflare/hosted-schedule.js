import { enqueueHostedChecks, claimHostedCheck, completeHostedCheck } from './hosted-checks.js';
import { runSchoologyDiscovery } from './schoology-discovery.js';
import { collectAccount } from '../collect-account.js';

// Called only by scheduled invocations. Parent sessions are never shared between jobs.
export async function runHostedSchedule(env, dependencies = {}) {
  const discovery = await (dependencies.discover ?? runSchoologyDiscovery)(env, dependencies);
  if (env.HOSTED_CHECKS_ENABLED !== 'true') return discovery;
  await enqueueHostedChecks(env);
  if (discovery.status !== 'idle') return { status: 'discovery_processed' };
  const job = await claimHostedCheck(env, 'schoology');
  if (!job) return { status: 'idle' };
  try {
    const launch = dependencies.launch ?? (async () => {
      const { launch: openBrowser } = await import('@cloudflare/playwright');
      return openBrowser(env.BROWSER);
    });
    const output = await (dependencies.collect ?? collectAccount)('schoology', job.credentials, job.children, launch);
    const accepted = await completeHostedCheck(env, 'schoology', job.id, job.lease, output);
    return { status: accepted ? 'recorded' : 'stale_job' };
  } catch { return { status: 'check_failed' }; }
  finally { job.credentials.username = ''; job.credentials.password = ''; }
}
