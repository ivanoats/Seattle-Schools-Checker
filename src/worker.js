import { chromium } from 'playwright';
import { mkdir, chmod, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CheckError, ensureLogin, sites } from './auth.js';
import { readSource } from './source.js';
import { readGlucose } from './glucose.js';
import { readSchoology, selectSample } from './schoology.js';

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
  const { service, operation, dates = [], credentials } = request;
  if (!sites[service] || !['login','check'].includes(operation)) throw new CheckError('invalid_request');
  const dataDir = path.join(homedir(), 'Library', 'Application Support', 'SeattleSourceChecker');
  await mkdir(dataDir, { recursive:true, mode:0o700 }); await chmod(dataDir,0o700);
  lockPath = path.join(dataDir, service + '.lock');
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new CheckError('check_already_running'); }
  const profile = path.join(dataDir, service + '-chrome');
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
  if (service === 'schoology') {
    try {await selectSample(page);}
    catch(error) {
      if (operation !== 'login' || error.status !== 'schoology_select_sample_required') throw error;
      // Interactive login may need the parent to select the linked child once.
      try {await page.waitForFunction(()=>document.querySelector('#child-session-banner')?.textContent.trim()==='You are viewing as Sample Student',null,{timeout:180000});}
      catch {throw error;}
    }
  }
  result = { status:'ok', service, authentication:credentials ? 'keychain' : 'existing_session', checkedAt:new Date().toISOString() };
  phase = 'report';
  if (operation === 'check') result.report = service === 'source' ? await readSource(page) : service === 'schoology' ? await readSchoology(page) : await readGlucose(page, dates);
  result.checkedAt = new Date().toISOString();
} catch (error) {
  // Do not return browser exception messages: they may include form values or URLs with tokens.
  result = { status:error instanceof CheckError ? error.status : 'check_failed', phase,
    ...(error instanceof CheckError && error.login ? {login:error.login} : {}),
    errorKind: ['TimeoutError','TypeError','SyntaxError'].includes(error.name) ? error.name : 'Error',
    codeLocation: error.stack?.match(/src\/(?:auth|source|glucose|schoology|worker)\.js:\d+:\d+/g)?.[0] || null,
    reason: [['Navigation interrupted','interrupted'],['net::ERR','network'],['strict mode','ambiguous_locator'],['Target page','browser_closed'],['route','routing'],['locator','page_layout']].find(([text])=>error.message?.includes(text))?.[1] || 'unclassified' };
  process.exitCode = 1;
} finally {
  try { await context?.close(); } catch { /* no diagnostics containing browser data */ }
  if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
process.stdout.write(JSON.stringify(result) + '\n');
