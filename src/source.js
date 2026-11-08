import { CheckError, sites } from './auth.js';
import { legacyChild } from './local-child.js';

export function parseAttendance(text) {
  return text.split('\n').map(line => line.match(/^(.*?) - (\d{2})\/(\d{2})\/(\d{4}) - ([A-Z]+)$/))
    .filter(Boolean).map(m => ({ period: m[1], date: `${m[4]}-${m[2]}-${m[3]}`, code: m[5] }));
}
export async function readSource(page, child = legacyChild) {
  const { tabLabel, tabHref, studentHeading } = child.providers.source;
  const verifyHeading = async label => {
    if (new URL(page.url()).origin !== sites.source.origin) throw new CheckError('source_child_tab_unverified');
    await page.getByRole('heading', { name: `${label}: ${studentHeading}`, exact: true }).waitFor();
  };
  await page.goto(sites.source.origin + '/guardian/home.html');
  const tabs = await page.getByRole('link', { name: tabLabel, exact: true }).all();
  const matches = [];
  for (const tab of tabs) {
    const href = await tab.getAttribute('href');
    // Existing PowerSchool tabs can switch the selected student via an event handler.
    if (!tabHref || (href && new URL(href, page.url()).href === sites.source.origin + tabHref)) matches.push(tab);
  }
  if (matches.length !== 1) throw new CheckError('source_child_tab_unverified');
  await matches[0].click();
  await verifyHeading('Grades');
  const courses = await page.locator('#tblgrades tr[id]').evaluateAll(rows => rows.map(r => {
    const c = Array.from(r.cells);
    return { course: c[11].innerText.split('\n')[0].trim(), period: c[0].innerText.trim(),
      q1: c[12].innerText.trim(), q2: c[13].innerText.trim(), semester: c[14].innerText.trim(),
      detail: c[14].querySelector('a')?.getAttribute('href'),
      absences: c[18].innerText.trim(), tardies: c[19].innerText.trim() };
  }));
  const absenceURL = await page.locator('#tblgrades a[href*="codes=*abs"]').last().getAttribute('href');
  const tardyURL = await page.locator('#tblgrades a[href*="codes=*tar"]').last().getAttribute('href');
  async function attendance(href) {
    if (!href) throw new CheckError('source_layout_changed');
    await page.goto(new URL(href, page.url()).href);
    const heading = page.getByRole('heading', { name: new RegExp(`: ${studentHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await heading.waitFor();
    return parseAttendance(await page.locator('#content-main').innerText());
  }
  const absences = await attendance(absenceURL);
  const tardies = await attendance(tardyURL);
  const assignmentRows = Array(courses.length).fill(null);
  for (const [index, c] of courses.entries()) {
    if (!c.detail) { c.missing = null; c.assignmentStatus = 'published_grade_unavailable'; delete c.detail; continue; }
    await page.goto(new URL(c.detail, sites.source.origin + '/guardian/').href);
    await verifyHeading('Class Score Detail');
    // Wait for Angular's published-assignment table or explicit empty result.
    try {
      await page.waitForFunction(() => document.querySelector('table [role="grid"]') || /No assignments/i.test(document.querySelector('#content-main')?.innerText || ''), null, { timeout: 5000 });
    } catch {
      c.missing = null; c.assignmentStatus = 'published_assignments_unavailable'; delete c.detail; continue;
    }
    const rows = await page.locator('tr[id^="assignmentsection_"]').evaluateAll(rows => rows.map(row => ({
      id: row.id, due: row.cells[0].innerText, assignment: row.cells[2].innerText,
      score: row.querySelector('.score')?.innerText, excluded: !!row.querySelector('.tt-excluded'),
      missing: !!row.querySelector('.tt-missing'),
    })));
    assignmentRows[index] = rows;
    c.missing = rows.filter(row => row.missing).map(({ id, missing, ...item }) => item);
    delete c.detail;
  }
  return { student: child.displayName, checkedAt: new Date().toISOString(), courses, absences, tardies, assignmentRows };
}
