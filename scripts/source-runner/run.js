import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CheckError, ensureLogin, sites } from '../../src/auth.js';
import { configuredChild } from '../../src/core/children.js';
import { observeSchool } from '../../src/core/observations.js';
import { readSource } from '../../src/source.js';
import { inspectPortalStart } from '../browser-run/portal-start.js';
import { credentialTag, decide, failureReason, intervalMs, nextState } from './policy.js';

const runner = 'aws-us-west-2';

// One browser and one sign-in serve every configured child.
// A failure before the first read applies to all of them.
async function readChildren(children, credentials) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 });
  const deadline = setTimeout(() => { browser.close().catch(() => null); }, 60000 + 45000 * children.length);
  try {
    const page = await browser.newPage({
      timezoneId: 'America/Los_Angeles', locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block',
    });
    page.setDefaultTimeout(15000);
    // Confirm the real login form before any credentials reach the page.
    const response = await page.goto(sites.source.start, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const start = await inspectPortalStart(page, response, sites.source.origin);
    if (start.result !== 'login_form_reached') throw new CheckError(start.result);
    await ensureLogin(page, 'source', credentials);
    const results = [];
    for (const child of children) {
      try {
        const { assignmentRows, ...report } = await readSource(page, child);
        if (report.courses.length === 0) throw new CheckError('source_courses_unavailable');
        results.push({ childId: child.id, provider: 'source', status: 'ok',
          observation: observeSchool({ provider: 'source', child, report, assignmentRows, observedAt: report.checkedAt }) });
      } catch (error) {
        results.push({ childId: child.id, provider: 'source', status: 'unavailable', reason: failureReason(error) });
      }
    }
    return results;
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => null);
  }
}

async function postRun(url, token, run) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(run),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch { /* Retry a network failure below. */ }
    if (attempt < 3) await new Promise(resolve => { setTimeout(resolve, 5000 * attempt); });
  }
  return false;
}

export function sourceChildren(config) {
  configuredChild(config);
  return config.children.filter(child => child.providers?.source);
}

// Runs at most one sign-in and reports every child's outcome to the Worker.
export async function runSourceChecks({ children, credentials, tag, state, interval, now = Date.now(),
  read = readChildren, post, saveState }) {
  const unavailable = reason => children.map(child => ({ childId: child.id, provider: 'source', status: 'unavailable', reason }));
  const decision = decide(state, { now, interval, tag });
  if (!decision.proceed && decision.reason === 'too_soon') return { status: 'too_soon', results: [] };

  let results = null;
  if (decision.proceed) {
    // Record the attempt first, so a crash cannot cause a rapid second sign-in.
    await saveState({ ...state, lastAttemptAt: new Date(now).toISOString() });
    let runFailure = null;
    try {
      results = await read(children, credentials);
    } catch (error) {
      runFailure = failureReason(error);
      results = unavailable(runFailure);
    }
    await saveState(nextState(state, { now, tag, runFailure }));
  } else {
    results = unavailable(decision.reason);
  }

  const posted = await post({ version: 1, runId: randomUUID(), runner, attemptedAt: new Date(now).toISOString(), results });
  return { status: posted ? 'posted' : 'ingest_failed',
    results: results.map(({ childId, status, reason }) => ({ childId, status, ...(reason && { reason }) })) };
}

function validIngestUrl(value) {
  const url = new URL(value);
  const plain = !url.username && !url.password && !url.search && !url.hash;
  return url.protocol === 'https:' && url.pathname === '/v1/ingest/source' && plain ? url : null;
}

// Returns the validated settings, or null when any of them is missing.
async function loadSettings(env) {
  try {
    const children = sourceChildren(JSON.parse(await readFile(env.SOURCE_CHILD_CONFIG, 'utf8')));
    const url = validIngestUrl(env.SOURCE_INGEST_URL);
    const token = env.SOURCE_INGEST_TOKEN ?? '';
    const credentials = { username: env.SOURCE_USERNAME ?? '', password: env.SOURCE_PASSWORD ?? '' };
    const complete = url && /^[a-f0-9]{64}$/.test(token) && credentials.username && credentials.password;
    return complete && children.length > 0 ? { children, url, token, credentials } : null;
  } catch {
    return null;
  }
}

async function main() {
  const settings = await loadSettings(process.env);
  if (!settings) return { status: 'config_required' };
  const { children, url, token, credentials } = settings;
  const stateDir = process.env.SOURCE_STATE_DIR || join(homedir(), '.local', 'state', 'source-runner');
  const statePath = join(stateDir, 'state.json');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let state = null;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* First run or unreadable state. */ }
  if (process.argv.includes('--clear-hold')) state = { ...state, hold: null, failures: 0 };
  return runSourceChecks({
    children, credentials, state, interval: intervalMs(process.env.SOURCE_MIN_INTERVAL_MINUTES),
    tag: credentialTag(token, credentials),
    post: run => postRun(url, token, run),
    saveState: async next => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await main();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!['posted', 'too_soon'].includes(summary.status)) process.exitCode = 1;
}
