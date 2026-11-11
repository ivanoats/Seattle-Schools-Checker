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
  let browser, input, stage = 'request';
  try {
    let body = '';
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
    await browser?.close().catch(() => {});
  }
}

function ssh(name, command, { input, timeout = 120000 } = {}) {
  return execFileSync('gh', ['codespace', 'ssh', '-c', name, '--', command], {
    cwd: root, input, timeout, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  }).toString();
}

async function runLocal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { service: 'source', status: 'interactive_terminal_required' };
  }
  let stage = 'configuration', codespace, credentials;
  let hideInput = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (hideInput) done();
      else process.stdout.write(chunk, encoding, done);
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const abort = new AbortController();
  terminal.on('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  let result;
  try {
    const config = JSON.parse(await readFile(join(homedir(), 'Library', 'Application Support',
      'SeattleSourceChecker', 'children.json'), 'utf8'));
    const child = configuredChild(config);
    if (!child.providers.source) throw new CheckError('child_provider_not_configured');
    const key = randomBytes(32).toString('hex');
    stage = 'mac_comparison_baseline';
    let baseline;
    try {
      const { stdout } = await exec(join(root, 'bin/checker'), ['check', 'source'],
        { timeout: 90000, maxBuffer: 2 * 1024 * 1024, signal: abort.signal });
      const local = JSON.parse(stdout);
      if (local.status === 'ok' && local.report?.student === child.displayName) baseline = digestSections(local.report, key);
    } catch { /* A failed local baseline does not block the hosted sign-in test. */ }
    abort.signal.throwIfAborted();

    stage = 'codespace_creation';
    console.log('Preparing a temporary hosted Linux machine. Chrome setup may take a few minutes.');
    const { stdout: name } = await exec('gh', ['codespace', 'create', '--repo', codespaceRepo,
      '--branch', 'main', '--machine', 'basicLinux32gb', '--location', 'WestUs2',
      '--display-name', 'source-live-verification', '--idle-timeout', '10m', '--retention-period', '1h',
      '--default-permissions'], { cwd: root, timeout: 120000 });
    codespace = name.trim();
    if (!/^[a-z0-9-]+$/.test(codespace)) throw new CheckError('codespace_name_unverified');
    abort.signal.throwIfAborted();

    stage = 'hosted_setup';
    const archive = execFileSync('tar', ['-cf', '-', 'package.json', 'package-lock.json',
      'src/auth.js', 'src/source.js', 'src/core/children.js',
      'scripts/browser-run/source-probe.js', 'scripts/browser-run/portal-start.js',
      'scripts/browser-run/source-live.js'], { cwd: root });
    let preflight;
    try {
      preflight = ssh(codespace, `set -eu
      umask 077
      mkdir -p /tmp/source-live-verification
      cd /tmp/source-live-verification
      tar -xf -
      npm ci --ignore-scripts --no-audit --no-fund >&2
      if ! command -v google-chrome >/dev/null; then npx --no-install playwright install --with-deps chrome >&2; fi
      node scripts/browser-run/source-probe.js`, { input: archive, timeout: 600000 });
    } catch (error) {
      try { preflight = JSON.parse(error.stdout?.toString()); } catch { throw error; }
      if (preflight.result === 'portal_request_rejected') throw new CheckError('portal_request_rejected');
      throw new CheckError('hosted_login_page_unverified');
    }
    if (JSON.parse(preflight).result !== 'login_form_reached') throw new CheckError('hosted_login_page_unverified');
    abort.signal.throwIfAborted();

    stage = 'credential_entry';
    const username = (await terminal.question('Source parent username: ', { signal: abort.signal })).trim();
    if (!username) throw new CheckError('credentials_required');
    credentials = { username, password: '' };
    process.stdout.write('Source password (hidden): ');
    hideInput = true;
    try {
      credentials.password = await terminal.question('', { signal: abort.signal });
    } finally {
      hideInput = false;
      process.stdout.write('\n');
    }
    if (!credentials.password) throw new CheckError('credentials_required');

    stage = 'hosted_check';
    // SSH transports the request directly to stdin. No secrets are put in
    // command arguments, shell variables, files, or output.
    const sourceChild = { id: child.id, displayName: child.displayName, providers: { source: child.providers.source } };
    try {
      result = JSON.parse(ssh(codespace, 'cd /tmp/source-live-verification && env -u DEBUG -u PWDEBUG -u NODE_DEBUG node scripts/browser-run/source-live.js --remote',
        { input: JSON.stringify({ credentials, child: sourceChild, key, baseline }) }));
    } catch (error) {
      let status;
      try { status = JSON.parse(error.stdout?.toString()); } catch { throw error; }
      if (status.service !== 'source' || !/^[a-z_]{1,64}$/.test(status.status)) throw error;
      result = { service: 'source', status: status.status, stage: status.stage };
    }
  } catch (error) {
    result = { service: 'source', status: error instanceof CheckError ? error.status
      : abort.signal.aborted ? 'cancelled' : 'check_failed', stage };
  } finally {
    if (credentials) { credentials.username = ''; credentials.password = ''; }
    terminal.close();
    if (codespace && /^[a-z0-9-]+$/.test(codespace)) {
      try { await exec('gh', ['codespace', 'delete', '-c', codespace, '--force'], { timeout: 30000 }); }
      catch {
        result = { ...result, cleanup: 'codespace_delete_unverified' };
        try { await exec('gh', ['codespace', 'stop', '-c', codespace], { timeout: 30000 }); }
        catch { /* The short idle timeout still applies. */ }
      }
    }
  }
  return result;
}

const result = process.argv[2] === '--remote' ? await runHosted() : await runLocal();
console.log(JSON.stringify(result));
if (result.status !== 'hosted_read_verified') process.exitCode = 1;
