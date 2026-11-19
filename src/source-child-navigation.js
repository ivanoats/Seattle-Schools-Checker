import { CheckError, sites } from './auth.js';

const pendingSwitches = new WeakMap();
export const sourceSwitchId = href => typeof href === 'string'
  ? /^javascript:switchStudent\((\d{1,12})\);?$/.exec(href)?.[1] ?? null : null;

// Only the single native form navigation caused by an observed child-tab click
// is allowed through discovery's POST guard. Never evaluate or replay handlers.
export function consumeSourceChildSwitch(page, request) {
  const pending = pendingSwitches.get(page);
  if (!pending || pending.used || request.method() !== 'POST' || !request.isNavigationRequest()
      || request.frame() !== page.mainFrame() || request.url() !== `${sites.source.origin}/guardian/home.html`
      || request.headers()['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return false;
  const fields = new URLSearchParams(request.postData() ?? '');
  if ([...fields.keys()].length !== 1 || fields.get('selected_student_id') !== pending.id) return false;
  pending.used = true;
  return true;
}

export async function clickSourceChildSwitch(page, tab, id) {
  const tabHref = await tab.getAttribute('href');
  if (!/^\d{1,12}$/.test(id) || sourceSwitchId(tabHref) !== id) {
    throw new CheckError('child_discovery_layout_unverified');
  }
  const active = await tab.evaluate(el => Boolean(el.closest('li.selected')));
  if (active) return;
  if (await page.locator('#switch_student_form').count() !== 1) throw new CheckError('child_discovery_layout_unverified');
  const validForm = await page.locator('#switch_student_form').evaluate(form =>
    form.action === `${location.origin}/guardian/home.html` && form.method.toLowerCase() === 'post'
      && form.elements.length === 1 && form.elements[0].name === 'selected_student_id'
      && form.elements[0].type === 'hidden');
  if (!validForm) throw new CheckError('child_discovery_layout_unverified');
  const before = await page.getByRole('heading', { name: /^Grades: / }).innerText();
  pendingSwitches.set(page, { id, used: false });
  try {
    await tab.click();
    await page.waitForFunction(({ href, previous }) => {
      const selected = Array.from(document.querySelectorAll('#students-list li.selected a'))
        .some(el => el.getAttribute('href') === href);
      const heading = Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).find(el => /^Grades: /.test(el.innerText));
      return selected && heading?.innerText !== previous;
    }, { href: tabHref, previous: before }, { timeout: 10000 });
  } finally { pendingSwitches.delete(page); }
}
