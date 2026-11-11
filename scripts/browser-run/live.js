import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CheckError, isSignedIn, sites } from '../../src/auth.js';
import { configuredChild } from '../../src/core/children.js';
import { readSchoology } from '../../src/schoology.js';
import { readSource } from '../../src/source.js';
import { acquireBrowserRun } from './session.js';
import { signInSchoology } from './schoology-login.js';

const [service, ...args] = process.argv.slice(2);
const unattended = args.includes('--unattended');
const [requestedChild] = args.filter(arg => arg !== '--unattended');
if (!['source', 'schoology'].includes(service) || (unattended && service !== 'schoology') ||
    !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run interactively: node scripts/browser-run/live.js source|schoology [child-id] [--unattended]');
  process.exit(2);
}

const localCheck = promisify(execFile);
let muteInput = false;
const terminalOutput = new Writable({
  write(chunk, encoding, done) {
    if (muteInput) done();
    else process.stdout.write(chunk, encoding, done);
  },
});
const terminal = createInterface({ input: process.stdin, output: terminalOutput, terminal: true, historySize: 0 });
const configPath = join(homedir(), 'Library', 'Application Support', 'SeattleSourceChecker', 'children.json');
const checker = fileURLToPath(new URL('../../bin/checker', import.meta.url));
const abort = new AbortController();
let stage = 'configuration';
let session = null;
let browser = null;
let report = null;
let child = null;
let credentials = null;
let loginHttpStatus = null;
terminal.on('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

function compare(left, right) {
  if (left == null || right == null) return 'unavailable';
  return isDeepStrictEqual(left, right) ? 'match' : 'different';
}

function compareSource(cloud, mac) {
  const roster = data => data.courses.map(({ course, period, semester }) => [course, period, semester]);
  const attendance = data => data.absences && data.tardies ? [data.absences, data.tardies] : null;
  const missingRows = data => data.courses.map(({ course, period, missing }) => [course, period, missing]);
  return { rosterAndSemesterGrades: compare(roster(cloud), roster(mac)),
    attendance: compare(attendance(cloud), attendance(mac)),
    missingRows: compare(missingRows(cloud), missingRows(mac)),
    missingCoverage: cloud.courses.some(course => course.missing === null)
      || mac.courses.some(course => course.missing === null) ? 'partial' : 'available' };
}

function compareSchoology(cloud, mac) {
  return Object.fromEntries(['overdue', 'upcoming', 'events', 'recentlyCompleted'].map(section => {
    const project = data => data[section]?.map(({ assignment, course, url, submissionStatus, scheduledAt }) =>
      [assignment, course, url, submissionStatus, scheduledAt]);
    return [section, compare(project(cloud), project(mac))];
  }));
}

try {
  child = configuredChild(JSON.parse(await readFile(configPath, 'utf8')), requestedChild);
  if (!child.providers[service]) throw new CheckError('child_provider_not_configured');
  if (unattended) {
    const username = (await terminal.question('Schoology parent email: ', { signal: abort.signal })).trim();
    if (!username) throw new CheckError('credentials_required');
    credentials = { username, password: '' };
    process.stdout.write('Schoology password (hidden): ');
    muteInput = true;
    try {
      credentials.password = await terminal.question('', { signal: abort.signal });
    } finally {
      muteInput = false;
      process.stdout.write('\n');
    }
    if (!credentials.password) throw new CheckError('credentials_required');
  } else {
    await terminal.question('Press Enter to start the one-time Cloudflare browser session. ', { signal: abort.signal });
  }
  stage = 'browser_acquisition';
  const hosts = [new URL(sites[service].origin).hostname];
  if (service === 'schoology') hosts.push('asset-cdn.schoology.com');
  session = await acquireBrowserRun(hosts, 240000);
  browser = await session.connect();
  abort.signal.throwIfAborted();
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block',
    acceptDownloads: false, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  stage = 'portal_navigation';
  const response = await page.goto(sites[service].start, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if ((await page.title()).trim() === 'Request Rejected') {
    throw new CheckError('portal_request_rejected');
  }
  if (!response || response.status() >= 400 || new URL(page.url()).origin !== sites[service].origin) {
    throw new CheckError(response?.status() === 403 ? 'portal_or_guardrail_blocked' : 'portal_start_unavailable');
  }

  const cdp = await context.newCDPSession(page);
  if (unattended) {
    stage = 'unattended_login';
    loginHttpStatus = await signInSchoology(page, cdp, credentials);
    credentials.username = '';
    credentials.password = '';
  } else {
    stage = 'manual_login';
    const { devtoolsFrontendUrl } = await cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs: 180000 });
    if (new URL(devtoolsFrontendUrl).origin !== 'https://live.browser.run') {
      throw new CheckError('unexpected_live_view_destination');
    }
    process.stdout.write('Open this private link yourself. It grants control of the session until it expires. Keep it in your terminal.\n');
    process.stdout.write(`${devtoolsFrontendUrl}\n`);
    process.stdout.write('Sign in on the school portal. In Schoology, select the student you want to verify.\n');
    await terminal.question('Return here and press Enter when ready to verify. ', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]) });
  }
  if (!await isSignedIn(page, service)) throw new CheckError('sign_in_unverified');

  stage = 'verified_read';
  const verifiedReport = await (service === 'source' ? readSource : readSchoology)(page, child);
  if (verifiedReport.student !== child.displayName) throw new CheckError('child_unverified');
  report = verifiedReport;
} catch (error) {
  const status = error instanceof CheckError ? error.status
    : /^(browser_run_acquire_http_\d+|cloudflare_(token|account_selection)_required)$/.test(error.message) ? error.message
      : abort.signal.aborted ? 'cancelled' : error.name === 'AbortError' ? 'handoff_timed_out' : 'check_failed';
  console.error(JSON.stringify({ service, status, stage,
    ...(unattended && { loginHttpStatus: error.httpStatus ?? loginHttpStatus ?? null }) }));
  process.exitCode = 1;
} finally {
  if (credentials) { credentials.username = ''; credentials.password = ''; }
  terminal.close();
  try { await session?.close(); } catch {
    console.error(JSON.stringify({ service, status: 'browser_cleanup_unverified' }));
    process.exitCode = 1;
  }
  await browser?.close().catch(() => null);
}

if (report) {
  const options = requestedChild ? ['--child', child.id] : [];
  const result = { service, status: 'cloud_read_verified', macComparison: 'unavailable',
    ...(unattended && { authentication: 'fresh_automated_login', loginHttpStatus }) };
  let mac = null;
  try {
    const { stdout } = await localCheck(checker, ['check', service, ...options],
      { maxBuffer: 2 * 1024 * 1024, timeout: 90000, signal: abort.signal });
    mac = JSON.parse(stdout);
  } catch (error) {
    try { mac = JSON.parse(error.stdout); } catch { /* Output only a status code. */ }
  }
  if (mac?.status === 'ok' && mac.report?.student === report.student) {
    result.macComparison = (service === 'source' ? compareSource : compareSchoology)(report, mac.report);
  } else {
    result.macCheckerStatus = mac?.status === 'ok' ? 'child_unverified'
      : /^[a-z_]{1,64}$/.test(mac?.status ?? '') ? mac.status : 'check_failed';
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
