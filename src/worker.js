import { chromium } from 'playwright';
import { mkdir, chmod, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CheckError, ensureLogin, sites } from './auth.js';
import { readSource } from './source.js';
import { readGlucose } from './glucose.js';
import { readSchoology, verifySchoologyChild } from './schoology.js';
import { configuredChild } from './core/children.js';
import { observeSchool } from './core/observations.js';

async function readLocalConfig(dataDir, filename, missingStatus) {
  let file;
  try { file = await readFile(path.join(dataDir, filename), 'utf8'); }
  catch (error) {
    throw new CheckError(error.code === 'ENOENT' ? missingStatus : 'local_config_unavailable');
  }
  try { return JSON.parse(file); }
  catch { throw new CheckError('invalid_local_config'); }
}

async function loadChild(dataDir, childId, service) {
  const config = await readLocalConfig(dataDir, 'children.json', 'child_config_required');
  let child;
  try { child = configuredChild(config, childId); }
  catch (error) {
    throw new CheckError(error.message === 'child_not_configured' ? error.message : 'invalid_child_config');
  }
  if (!child.providers[service]) throw new CheckError('child_provider_not_configured');
  return child;
}

process.umask(0o077);
let context, lock, lockPath;
let result;
let phase = 'request';
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new CheckError('invalid_request');
  }
  const request = JSON.parse(input); input = '';
  const { service, operation, dates = [], credentials, childId } = request;
  if (!Object.hasOwn(sites, service) || !['login','check'].includes(operation)) throw new CheckError('invalid_request');
  const dataDir = path.join(homedir(), 'Library', 'Application Support', 'SeattleSourceChecker');
  await mkdir(dataDir, { recursive:true, mode:0o700 }); await chmod(dataDir,0o700);
  const child = service === 'sugarmate' ? null : await loadChild(dataDir, childId, service);
  const feed = service === 'sugarmate' && operation === 'check'
    ? await readLocalConfig(dataDir, 'sugarmate.json', 'glucose_feed_config_required') : null;
  lockPath = path.join(dataDir, service + '.lock');
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new CheckError('check_already_running'); }
  const profileName = service === 'schoology' && child.id !== 'default-child'
    ? `schoology-${child.id}-chrome` : `${service}-chrome`;
  const profile = path.join(dataDir, profileName);
  await mkdir(profile, { mode:0o700, recursive:true }); await chmod(profile,0o700);
  phase = 'browser';
  context = await chromium.launchPersistentContext(profile, { channel:'chrome', headless:operation !== 'login',
    timezoneId:'America/Los_Angeles', locale:'en-US', acceptDownloads:false,
    serviceWorkers:'block', timeout:20000 });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  phase = 'authentication';
  await ensureLogin(page, service, credentials, operation === 'login' ? 180000 : 15000);
  if (credentials) { credentials.password = ''; credentials.username = ''; }
  if (service === 'schoology' && operation === 'login') {
    await verifySchoologyChild(page, child, 180000);
  }
  result = { status:'ok', service, authentication:credentials ? 'keychain' : 'existing_session', checkedAt:new Date().toISOString() };
  phase = 'report';
  if (operation === 'check') {
    if (child) {
      const read = service === 'source' ? readSource : readSchoology;
      const { assignmentRows, ...report } = await read(page, child);
      result.report = report;
      result.observation = observeSchool({ provider: service, child, report, assignmentRows,
        observedAt: new Date().toISOString() });
    } else {
      result.report = await readGlucose(page, dates, feed);
    }
  }
  result.checkedAt = new Date().toISOString();
} catch (error) {
  // Do not return browser exception messages: they may include form values or URLs with tokens.
  result = { status:error instanceof CheckError ? error.status : 'check_failed', phase,
    ...(error instanceof CheckError && error.login ? {login:error.login} : {}),
    errorKind: ['TimeoutError','TypeError','SyntaxError'].includes(error.name) ? error.name : 'Error',
    codeLocation: error.stack?.match(/src\/(?:core\/)?[a-z-]+\.js:\d+:\d+/)?.[0] || null,
    reason: [['Navigation interrupted','interrupted'],['net::ERR','network'],['strict mode','ambiguous_locator'],['Target page','browser_closed'],['route','routing'],['locator','page_layout']].find(([text])=>error.message?.includes(text))?.[1] || 'unclassified' };
  process.exitCode = 1;
} finally {
  try { await context?.close(); } catch { /* no diagnostics containing browser data */ }
  if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
process.stdout.write(JSON.stringify(result) + '\n');
