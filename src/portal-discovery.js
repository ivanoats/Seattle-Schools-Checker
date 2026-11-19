import { CheckError, isSignedIn, sites } from './auth.js';
import { sourceSwitchId, clickSourceChildSwitch } from './source-child-navigation.js';

const text = value => typeof value === 'string' && value.trim() && value.trim().length <= 150;
const sourceLinks = '#students-list a, a[href^="/guardian/home.html?student="]';
const schoologyLinks = 'a[href*="/parent/index?child="], a[href^="/parent/switch_child/"]';

export function schoologyChildHref(href) {
  try {
    const url = new URL(href, sites.schoology.origin);
    if (url.origin !== sites.schoology.origin || url.username || url.password || url.hash) return null;
    if (/^\/parent\/switch_child\/\d+$/.test(url.pathname) && !url.search) return url.pathname;
    return url.pathname === '/parent/index' && /^\?child=\d+$/.test(url.search)
      ? url.pathname + url.search : null;
  } catch { return null; }
}

async function verifiedPage(page, provider) {
  if (new URL(page.url()).origin !== sites[provider].origin || !await isSignedIn(page, provider)) {
    throw new CheckError('sign_in_unverified');
  }
}

function sourceChoice(link) {
  if (!text(link.label)) throw new CheckError('child_discovery_layout_unverified');
  const href = link.href && new URL(link.href, sites.source.origin);
  const navigates = href?.origin === sites.source.origin && href.pathname === '/guardian/home.html'
    && /^\d+$/.test(href.searchParams.get('student') ?? '');
  const tabId = /^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(link.id ?? '') ? link.id : null;
  const switchId = sourceSwitchId(link.href);
  if (navigates) return { remoteId: href.pathname + href.search, mapping: { tabHref: href.pathname + href.search } };
  if (switchId) return { remoteId: `student-switch:${switchId}`, mapping: { tabSwitchId: switchId } };
  if (tabId) return { remoteId: tabId, mapping: { tabId } };
  throw new CheckError('child_discovery_layout_unverified');
}

async function selectSourceIdTab(page, tabId) {
  // Only a rendered child-tab click; no internal API or JavaScript handler replay.
  const tab = page.locator(`[id="${tabId}"]`);
  const active = await tab.evaluate(el => el.matches('[aria-current="page"], [aria-selected="true"], .selected')
    || Boolean(el.closest('li.selected, li.active')));
  if (active) return;
  const before = await page.getByRole('heading', { name: /^Grades: / }).innerText();
  await tab.click();
  await page.waitForFunction(({ id, previous }) => {
    const el = document.getElementById(id);
    const selected = el?.matches('[aria-current="page"], [aria-selected="true"], .selected') || Boolean(el?.closest('li.selected, li.active'));
    const heading = Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).find(e => /^Grades: /.test(e.innerText));
    return selected && heading?.innerText !== previous;
  }, { id: tabId, previous: before }, { timeout: 10000 });
}

async function selectSourceChoice(page, choice, label) {
  await page.goto(`${sites.source.origin}/guardian/home.html`, { waitUntil: 'domcontentloaded' });
  const { tabHref, tabSwitchId, tabId } = choice.mapping;
  if (tabHref) {
    await page.goto(`${sites.source.origin}${tabHref}`, { waitUntil: 'domcontentloaded' });
  } else if (tabSwitchId) {
    const matches = [];
    for (const candidate of await page.locator('#students-list a').filter({ hasText: label }).all()) {
      if (sourceSwitchId(await candidate.getAttribute('href')) === tabSwitchId) matches.push(candidate);
    }
    if (matches.length !== 1) throw new CheckError('child_identity_ambiguous');
    await clickSourceChildSwitch(page, matches[0], tabSwitchId);
  } else {
    await selectSourceIdTab(page, tabId);
  }
}

async function sourceIdentity(page) {
  await verifiedPage(page, 'source');
  const heading = page.getByRole('heading', { name: /^Grades: / });
  await heading.waitFor();
  const studentHeading = (await heading.innerText()).replace(/^Grades:\s*/, '').trim();
  if (!text(studentHeading) || !studentHeading.includes(',')) throw new CheckError('child_identity_unverified');
  const [surname, ...given] = studentHeading.split(',');
  return { studentHeading, displayName: `${given.join(',').trim()} ${surname.trim()}` };
}

export async function discoverSourceChildren(page) {
  await page.goto(`${sites.source.origin}/guardian/home.html`, { waitUntil: 'domcontentloaded' });
  await verifiedPage(page, 'source');
  const links = await page.locator(sourceLinks).evaluateAll(elements => elements.filter(e => e.getClientRects().length)
    .map(e => ({ label: e.innerText.trim(), href: e.href, id: e.id })));
  if (!links.length || links.length > 20) throw new CheckError('child_discovery_layout_unverified');
  const seen = new Set(); const children = [];
  for (const link of links) {
    const choice = sourceChoice(link);
    if (seen.has(choice.remoteId)) continue;
    seen.add(choice.remoteId);
    await selectSourceChoice(page, choice, link.label);
    const { studentHeading, displayName } = await sourceIdentity(page);
    if (children.some(child => child.mapping.studentHeading === studentHeading)) throw new CheckError('child_identity_ambiguous');
    children.push({ remoteId: choice.remoteId, displayName,
      mapping: { tabLabel: link.label, studentHeading, ...choice.mapping } });
  }
  return children;
}

export async function discoverSchoologyChildren(page) {
  await page.goto(sites.schoology.start, { waitUntil: 'domcontentloaded' });
  // The modern header mounts the child list only when its account menu opens.
  // Use its stable portal marker, never a guessed parent or child name.
  const accountControl = page.locator('[data-sgy-sitenav="header-my-account-menu"] button[data-sgy-sitenav="nav-trigger"][aria-haspopup]')
    .filter({ visible: true });
  if (await page.locator('script[src^="https://ui.schoology.com/platform/site-navigation-ui/"]').count()) {
    try { await accountControl.first().waitFor({ timeout: 10000 }); }
    catch { throw new CheckError('child_discovery_layout_unverified'); }
  }
  await verifiedPage(page, 'schoology');
  const accountCount = await accountControl.count();
  if (accountCount > 1) throw new CheckError('child_discovery_layout_unverified');
  if (accountCount === 1) {
    if (await accountControl.getAttribute('aria-expanded') === 'false') await accountControl.click();
    try { await page.locator(schoologyLinks).filter({ visible: true }).first().waitFor({ timeout: 5000 }); }
    catch { throw new CheckError('child_discovery_layout_unverified'); }
  } else {
    // Retain support for older headers with an explicitly associated list.
    const controlIds = await page.locator('[aria-controls][aria-expanded="false"]').evaluateAll((elements, selector) => elements.filter(e => {
      const target = document.getElementById(e.getAttribute('aria-controls'));
      return e.getClientRects().length && target?.querySelector(selector);
    }).map(e => e.getAttribute('aria-controls')), schoologyLinks);
    if (controlIds.length === 1) {
      for (const control of await page.locator('[aria-controls][aria-expanded="false"]').all()) {
        if (await control.getAttribute('aria-controls') === controlIds[0]) await control.click();
      }
    }
  }
  const links = await page.locator(schoologyLinks).evaluateAll(elements => elements.filter(e => e.getClientRects().length)
    .map(e => ({ label: e.innerText.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '', href: e.getAttribute('href') })));
  if (!links.length || links.length > 20) throw new CheckError('child_discovery_layout_unverified');
  const children = []; const seen = new Set();
  for (const link of links) {
    const href = schoologyChildHref(link.href);
    if (!href || !text(link.label)) throw new CheckError('child_discovery_layout_unverified');
    if (seen.has(href)) continue;
    seen.add(href);
    await page.goto(sites.schoology.origin + href, { waitUntil: 'domcontentloaded' });
    await verifiedPage(page, 'schoology');
    const banner = page.locator('#child-session-banner');
    await banner.waitFor({ state: 'visible' });
    const value = (await banner.innerText()).trim();
    if (value !== `You are viewing as ${link.label}`) throw new CheckError('child_identity_unverified');
    if (children.some(c => c.mapping.banner === value)) throw new CheckError('child_identity_ambiguous');
    children.push({ remoteId: href, displayName: link.label, mapping: { banner: value, selectionHref: href } });
  }
  return children;
}
