import { chromium } from 'playwright';
import { mkdir, chmod, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CheckError, ensureLogin, sites } from './auth.js';
import { readSource } from './source.js';
import { readGlucose } from './glucose.js';

process.umask(0o077);
let context, lock, lockPath;
let result;
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
  context = await chromium.launchPersistentContext(profile, { channel:'chrome', headless:true,
    timezoneId:'America/Los_Angeles', locale:'en-US', acceptDownloads:false,
    serviceWorkers:'block', timeout:20000 });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  await ensureLogin(page, service, credentials);
  if (credentials) { credentials.password = ''; credentials.username = ''; }
  result = { status:'ok', service, checkedAt:new Date().toISOString() };
  if (operation === 'check') result.report = service === 'source' ? await readSource(page) : await readGlucose(page, dates);
} catch (error) {
  // Do not return browser exception messages: they may include form values or URLs with tokens.
  result = { status:error instanceof CheckError ? error.status : 'check_failed' };
  process.exitCode = 1;
} finally {
  try { await context?.close(); } catch { /* no diagnostics containing browser data */ }
  if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
process.stdout.write(JSON.stringify(result) + '\n');
