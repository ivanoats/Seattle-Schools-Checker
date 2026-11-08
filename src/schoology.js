import { CheckError, sites } from './auth.js';

export async function verifySchoologyChild(page, child, timeout = 10000) {
  await page.goto(sites.schoology.start, {waitUntil:'domcontentloaded'});
  try {
    await page.waitForFunction(banner => {
      const selected = document.querySelector('#child-session-banner');
      return selected?.getClientRects().length && selected.innerText.trim() === banner;
    }, child.providers.schoology.banner, { timeout });
  } catch {
    throw new CheckError('schoology_select_child_required');
  }
}

// Only inspect rendered rows. Schoology keeps future/extra overdue rows hidden
// in its DOM; these are not evidence of an active overdue status.
export function summaryRows(root) {
  if (!root) return null;
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  return Array.from(root.querySelectorAll('.upcoming-event, .recently-completed-event')).filter(visible).map(el => {
    const link=el.querySelector('.event-title a, .recently-completed-title a');
    if (!link) return null;
    const url=new URL(link.getAttribute('href'),'https://app.schoology.com');
    if (url.origin !== 'https://app.schoology.com') return null;
    const raw=el.getAttribute('data-start');
    const epoch=raw && Number(raw);
    return {assignment:link.innerText.trim(),url:url.href,
      course:el.querySelector('[aria-label]')?.getAttribute('aria-label')?.trim() || null,
      description:el.innerText.trim(),
      submissionStatus:el.querySelector('.recently-completed-grade')?.getAttribute('aria-label') || null,
      dateLabel:el.querySelector('img[alt]')?.getAttribute('alt') || null,
      scheduledAt:epoch && Number.isFinite(epoch) ? new Date(epoch*1000).toISOString() : null};
  }).filter(Boolean);
}

export async function readSchoology(page, child) {
  await verifySchoologyChild(page, child);
  await page.locator('#right-column-inner').waitFor({ state: 'attached' });
  // The overdue request finishes later than the other sidebar requests. Until
  // real rows are visible, absence of rows must remain unknown, not clear.
  let overdueReady=false;
  try {await page.locator('#overdue-submissions .upcoming-event').first().waitFor({timeout:10000});overdueReady=true;}
  catch {/* Leave the section unknown if no positive rendered result is available. */}
  async function rows(selector) {
    const target=page.locator(selector).first();
    return await target.isVisible() ? await target.evaluate(summaryRows) : null;
  }
  async function headingRows(name) {
    const h=page.getByRole('heading',{name,exact:true});
    return await h.count() ? await h.locator('..').evaluate(summaryRows) : null;
  }
  const report={student:child.displayName,timezone:'America/Los_Angeles',
    overdue:overdueReady ? await rows('#overdue-submissions') : null,
    upcoming:await rows('.upcoming-submissions'),
    events:await headingRows('Upcoming Events'),
    recentlyCompleted:await headingRows('Recently Completed')};
  const more=page.getByRole('button',{name:/\d+ more overdue/});
  if (await more.isVisible()) {
    await more.click();
    await page.locator('#overdue-popup .upcoming-event').first().waitFor();
    report.overdue=await page.locator('#overdue-popup').evaluate(summaryRows);
    report.overdueCoverage='expanded_visible_list';
  } else report.overdueCoverage=report.overdue === null ? 'unavailable' : 'visible_summary';
  report.limitations=['Schoology overdue is separate from Source missing.',
    'Summary only: open relevant details for instructions, feedback and verified submission status.',
    'Null sections are unavailable; empty summary sections do not prove no work is assigned.'];
  return report;
}
