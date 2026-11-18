import { CheckError, isSignedIn, sites } from './auth.js';

const text = value => typeof value === 'string' && value.trim() && value.trim().length <= 150;
const sourceLinks = '#students-list a, a[href^="/guardian/home.html?student="]';
const schoologyLinks = 'a[href*="/parent/index?child="]';

export function schoologyChildHref(href) {
  try {
    const url = new URL(href, sites.schoology.origin);
    return url.origin === sites.schoology.origin && url.pathname === '/parent/index'
      && /^\d+$/.test(url.searchParams.get('child') ?? '') && [...url.searchParams.keys()].every(k => k === 'child')
      ? url.pathname + url.search : null;
  } catch { return null; }
}

async function verifiedPage(page, provider) {
  if (new URL(page.url()).origin !== sites[provider].origin || !await isSignedIn(page, provider)) {
    throw new CheckError('sign_in_unverified');
  }
}

export async function discoverSourceChildren(page) {
  await page.goto(sites.source.origin + '/guardian/home.html', { waitUntil: 'domcontentloaded' });
  await verifiedPage(page, 'source');
  const links = await page.locator(sourceLinks).evaluateAll(elements => elements.filter(e => e.getClientRects().length)
    .map(e => ({ label: e.innerText.trim(), href: e.getAttribute('href'), id: e.id })));
  if (!links.length || links.length > 20) throw new CheckError('child_discovery_layout_unverified');
  const seen = new Set(); const children = [];
  for (const link of links) {
    if (!text(link.label)) throw new CheckError('child_discovery_layout_unverified');
    const href = link.href && new URL(link.href, sites.source.origin);
    const navigates = href?.origin === sites.source.origin && href.pathname === '/guardian/home.html'
      && /^\d+$/.test(href.searchParams.get('student') ?? '');
    const tabId = /^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(link.id ?? '') ? link.id : null;
    if (!navigates && !tabId) throw new CheckError('child_discovery_layout_unverified');
    const remoteId = navigates ? href.pathname + href.search : tabId;
    if (seen.has(remoteId)) continue;
    seen.add(remoteId);
    await page.goto(sites.source.origin + '/guardian/home.html', { waitUntil: 'domcontentloaded' });
    if (navigates) {
      await page.goto(href.href, { waitUntil: 'domcontentloaded' });
    } else {
      // Only a rendered child-tab click; no internal API or JavaScript handler replay.
      await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 10000 }), page.locator(`[id="${tabId}"]`).click()]);
    }
    await verifiedPage(page, 'source');
    const heading = page.getByRole('heading', { name: /^Grades: / });
    await heading.waitFor();
    const studentHeading = (await heading.innerText()).replace(/^Grades:\s*/, '').trim();
    if (!text(studentHeading) || !studentHeading.includes(',')) throw new CheckError('child_identity_unverified');
    const [surname, ...given] = studentHeading.split(',');
    const displayName = `${given.join(',').trim()} ${surname.trim()}`;
    if (children.some(c => c.mapping.studentHeading === studentHeading)) throw new CheckError('child_identity_ambiguous');
    children.push({ remoteId, displayName, mapping: { tabLabel: link.label, studentHeading,
      ...(navigates ? { tabHref: href.pathname + href.search } : { tabId }) } });
  }
  return children;
}

export async function discoverSchoologyChildren(page) {
  await page.goto(sites.schoology.start, { waitUntil: 'domcontentloaded' });
  await verifiedPage(page, 'schoology');
  // Open only a control explicitly associated with a child-list container.
  const controlIds = await page.locator('[aria-controls][aria-expanded="false"]').evaluateAll(elements => elements.filter(e => {
    const target = document.getElementById(e.getAttribute('aria-controls'));
    return e.getClientRects().length && target?.querySelector('a[href*="/parent/index?child="]');
  }).map(e => e.getAttribute('aria-controls')));
  if (controlIds.length === 1) {
    for (const control of await page.locator('[aria-controls][aria-expanded="false"]').all()) {
      if (await control.getAttribute('aria-controls') === controlIds[0]) await control.click();
    }
  }
  const links = await page.locator(schoologyLinks).evaluateAll(elements => elements.filter(e => e.getClientRects().length)
    .map(e => ({ label: e.innerText.trim(), href: e.getAttribute('href') })));
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
