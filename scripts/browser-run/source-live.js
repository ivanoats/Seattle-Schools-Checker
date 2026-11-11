import { execFile, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CheckError, ensureLogin } from '../../src/auth.js';
import { configuredChild } from '../../src/core/children.js';
import { trustedCommand } from './commands.js';
import { readSource } from '../../src/source.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const codespaceRepo = 'ivanoats/Seattle-Schools-Checker';

function digestSections(report, key) {
  const courses = report.courses;
  const sections = {
    rosterAndGrades: courses.map(({ course, period, q1, q2, semester }) => [course, period, q1, q2, semester]),
    missingFlags: courses.map(({ course, period, missing }) => [course, period, missing]),
    attendance: report.absences && report.tardies ? [report.absences, report.tardies] : null,
  };
  return Object.fromEntries(Object.entries(sections).map(([section, records]) =>
    [section, records === null ? null : createHmac('sha256', key).update(JSON.stringify(records)).digest('hex')]));
}

async function runHosted() {
  let browser = null;
  let input = null;
  let stage = 'request';
  try {
    let body = '';
    // Decode as one stream so a character split across chunks stays intact.
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 8192) throw new CheckError('invalid_request');
    }
    input = JSON.parse(body);
    body = '';
    if (!input?.credentials?.username || !input?.credentials?.password ||
        typeof input.credentials.username !== 'string' || typeof input.credentials.password !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.key ?? '')) throw new CheckError('invalid_request');
    const child = configuredChild({ defaultChild: input.child?.id, children: [input.child] });
    if (!child.providers.source) throw new CheckError('child_provider_not_configured');
    stage = 'browser';
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 20000 });
    const page = await browser.newPage({ timezoneId: 'America/Los_Angeles', locale: 'en-US',
      acceptDownloads: false, serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    stage = 'login';
    await ensureLogin(page, 'source', input.credentials);
    input.credentials.username = '';
    input.credentials.password = '';
    stage = 'verified_read';
    const report = await readSource(page, child);
    const hosted = digestSections(report, input.key);
    const comparison = Object.fromEntries(Object.entries(hosted).map(([section, digest]) => {
      const mac = input.baseline?.[section];
      return [section, digest == null || mac == null ? 'unavailable' : mac === digest ? 'match' : 'different'];
    }));
    return { service: 'source', status: 'hosted_read_verified', authentication: 'fresh_automated_login',
      macComparison: comparison, missingCoverage: report.courses.some(course => course.missing === null) ? 'partial' : 'available' };
  } catch (error) {
    return { service: 'source', status: error instanceof CheckError ? error.status : 'check_failed', stage };
  } finally {
    if (input?.credentials) { input.credentials.username = ''; input.credentials.password = ''; }
    await browser?.close().catch(() => null);
  }
}

const codespaceName = /^[a-z0-9-]+$/;
// A private directory in the hosted user's home, not a shared temporary one.
const hostedDirectory = '"$HOME/source-live-verification"';
const shippedFiles = ['package.json', 'package-lock.json',
  'src/auth.js', 'src/source.js', 'src/core/children.js',
  'scripts/browser-run/commands.js', 'scripts/browser-run/portal-start.js',
  'scripts/browser-run/source-probe.js', 'scripts/browser-run/source-live.js'];
const setupCommand = `set -eu
umask 077
mkdir -p ${hostedDirectory}
cd ${hostedDirectory}
tar -xf -
npm ci --ignore-scripts --no-audit --no-fund >&2
if ! command -v google-chrome >/dev/null; then npx --no-install playwright install --with-deps chrome >&2; fi
node scripts/browser-run/source-probe.js`;

function say(message) {
  process.stdout.write(`${message}\n`);
}

function ssh(name, command, { input, timeout = 120000 } = {}) {
  return execFileSync(trustedCommand('gh'), ['codespace', 'ssh', '-c', name, '--', command], {
    cwd: root, input, timeout, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  }).toString();
}

function checkerStatus(output) {
  return /^[a-z_]{1,64}$/.test(output?.status ?? '') ? output.status : 'check_failed';
}

function setupFailureReason(error) {
  if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') return 'timeout';
  if (error.code === 'ENOBUFS') return 'output_limit';
  const log = error.stderr?.toString() ?? '';
  if (/Temporary failure resolving|Could not resolve|EAI_AGAIN|ENOTFOUND|ECONNRESET|Failed to fetch/i.test(log)) return 'network';
  if (/npm (ERR!|error)/i.test(log)) return 'npm_install';
  if (/^E: /m.test(log) || /Failed to install browsers/i.test(log)) return 'chrome_install';
  if (/codespace|connection (closed|refused)|ssh/i.test(log)) return 'ssh';
  return 'unclassified';
}

async function loadSourceChild() {
  const config = JSON.parse(await readFile(join(homedir(), 'Library', 'Application Support',
    'SeattleSourceChecker', 'children.json'), 'utf8'));
  const child = configuredChild(config);
  if (!child.providers.source) throw new CheckError('child_provider_not_configured');
  return child;
}

// A failed local baseline does not block the hosted sign-in test.
async function readMacBaseline(child, key, signal) {
  try {
    const { stdout } = await exec(join(root, 'bin/checker'), ['check', 'source'],
      { timeout: 90000, maxBuffer: 2 * 1024 * 1024, signal });
    const local = JSON.parse(stdout);
    if (local.status !== 'ok') return { digests: null, status: checkerStatus(local) };
    if (local.report?.student !== child.displayName) return { digests: null, status: 'child_unverified' };
    return { digests: digestSections(local.report, key), status: 'ok' };
  } catch (error) {
    try { return { digests: null, status: checkerStatus(JSON.parse(error.stdout)) }; }
    catch { return { digests: null, status: 'check_failed' }; }
  }
}

async function createCodespace() {
  const { stdout } = await exec(trustedCommand('gh'), ['codespace', 'create', '--repo', codespaceRepo,
    '--branch', 'main', '--machine', 'basicLinux32gb', '--location', 'WestUs2',
    '--display-name', 'source-live-verification', '--idle-timeout', '10m', '--retention-period', '1h',
    '--default-permissions'], { cwd: root, timeout: 120000 });
  return stdout.trim();
}

// Returns the probe result, or a bounded failure reason when setup did
// not get as far as the probe. No credentials exist at this stage.
function runHostedSetup(codespace, archive) {
  try {
    return { result: JSON.parse(ssh(codespace, setupCommand, { input: archive, timeout: 600000 })).result ?? 'unverified' };
  } catch (error) {
    try { return { result: JSON.parse(error.stdout?.toString()).result ?? 'unverified' }; }
    catch { return { failure: setupFailureReason(error) }; }
  }
}

async function verifyHostedLoginPage(codespace) {
  const archive = execFileSync('/usr/bin/tar', ['-cf', '-', ...shippedFiles], { cwd: root });
  let outcome = runHostedSetup(codespace, archive);
  if (outcome.failure === 'network') {
    say('Hosted setup hit a network error. Retrying once.');
    await new Promise(resolve => { setTimeout(resolve, 15000); });
    outcome = runHostedSetup(codespace, archive);
  }
  if (outcome.failure) throw new CheckError(`hosted_setup_failed_${outcome.failure}`);
  if (outcome.result === 'portal_request_rejected') throw new CheckError('portal_request_rejected');
  if (outcome.result !== 'login_form_reached') throw new CheckError('hosted_login_page_unverified');
}

// Fills the caller's object so the caller can always clear it afterwards.
async function promptCredentials(terminal, mute, signal, credentials) {
  credentials.username = (await terminal.question('Source parent username: ', { signal })).trim();
  if (!credentials.username) throw new CheckError('credentials_required');
  process.stdout.write('Source password (hidden): ');
  mute.on = true;
  try {
    credentials.password = await terminal.question('', { signal });
  } finally {
    mute.on = false;
    process.stdout.write('\n');
  }
  if (!credentials.password) throw new CheckError('credentials_required');
}

// SSH transports the request directly to stdin. No secrets are put in
// command arguments, shell variables, files, or output.
function runHostedCheck(codespace, request) {
  try {
    return JSON.parse(ssh(codespace,
      `cd ${hostedDirectory} && env -u DEBUG -u PWDEBUG -u NODE_DEBUG node scripts/browser-run/source-live.js --remote`,
      { input: JSON.stringify(request) }));
  } catch (error) {
    let status = null;
    try { status = JSON.parse(error.stdout?.toString()); } catch { throw error; }
    if (status.service !== 'source' || !/^[a-z_]{1,64}$/.test(status.status)) throw error;
    return { service: 'source', status: status.status, stage: status.stage };
  }
}

// Returns false when deletion could not be confirmed.
async function deleteCodespace(codespace) {
  const gh = trustedCommand('gh');
  try {
    await exec(gh, ['codespace', 'delete', '-c', codespace, '--force'], { timeout: 30000 });
    return true;
  } catch {
    try { await exec(gh, ['codespace', 'stop', '-c', codespace], { timeout: 30000 }); }
    catch { /* The short idle timeout still applies. */ }
    return false;
  }
}

async function runLocal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { service: 'source', status: 'interactive_terminal_required' };
  }
  const mute = { on: false };
  const output = new Writable({
    write(chunk, encoding, done) {
      if (mute.on) done();
      else process.stdout.write(chunk, encoding, done);
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const abort = new AbortController();
  terminal.on('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  const credentials = { username: '', password: '' };
  let stage = 'configuration';
  let codespace = null;
  let result = null;
  try {
    const child = await loadSourceChild();
    const key = randomBytes(32).toString('hex');
    stage = 'mac_comparison_baseline';
    const mac = await readMacBaseline(child, key, abort.signal);
    abort.signal.throwIfAborted();

    stage = 'codespace_creation';
    say('Preparing a temporary hosted Linux machine. Chrome setup may take a few minutes.');
    const created = await createCodespace();
    if (!codespaceName.test(created)) throw new CheckError('codespace_name_unverified');
    codespace = created;
    abort.signal.throwIfAborted();

    stage = 'hosted_setup';
    await verifyHostedLoginPage(codespace);
    abort.signal.throwIfAborted();

    stage = 'credential_entry';
    await promptCredentials(terminal, mute, abort.signal, credentials);
    abort.signal.throwIfAborted();

    stage = 'hosted_check';
    const sourceChild = { id: child.id, displayName: child.displayName, providers: { source: child.providers.source } };
    result = runHostedCheck(codespace, { credentials, child: sourceChild, key, baseline: mac.digests ?? undefined });
    if (!mac.digests) result = { ...result, macBaseline: mac.status };
  } catch (error) {
    let status = 'check_failed';
    if (error instanceof CheckError) status = error.status;
    else if (abort.signal.aborted) status = 'cancelled';
    result = { service: 'source', status, stage };
  } finally {
    credentials.username = '';
    credentials.password = '';
    terminal.close();
    if (codespace && !await deleteCodespace(codespace)) result = { ...result, cleanup: 'codespace_delete_unverified' };
  }
  return result;
}

const result = process.argv[2] === '--remote' ? await runHosted() : await runLocal();
say(JSON.stringify(result));
if (result.status !== 'hosted_read_verified') process.exitCode = 1;
