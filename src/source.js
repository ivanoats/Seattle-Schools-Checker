import { CheckError, sites } from './auth.js';

export function parseAttendance(text) {
  return text.split('\n').map(line => line.match(/^(.*?) - (\d{2})\/(\d{2})\/(\d{4}) - ([A-Z]+)$/))
    .filter(Boolean).map(m => ({ period: m[1], date: `${m[4]}-${m[2]}-${m[3]}`, code: m[5] }));
}
export async function readSource(page) {
  await page.goto(sites.source.origin + '/guardian/home.html');
  await page.getByRole('link', { name: 'Sample', exact: true }).click();
  await page.getByRole('heading', { name: 'Grades: Student, Sample', exact: true }).waitFor();
  const courses = await page.locator('#tblgrades tr[id]').evaluateAll(rows => rows.map(r => {
    const c = Array.from(r.cells);
    return { course: c[11].innerText.split('\n')[0].trim(), period: c[0].innerText.trim(),
      q1: c[12].innerText.trim(), q2: c[13].innerText.trim(), semester: c[14].innerText.trim(),
      detail: c[14].querySelector('a')?.getAttribute('href'),
      absences: c[18].innerText.trim(), tardies: c[19].innerText.trim() };
  }));
  const absenceURL = await page.locator('.termAbsTotal a').getAttribute('href');
  const tardyURL = await page.locator('.termTarTotal a').getAttribute('href');
  async function attendance(href) {
    if (!href) throw new CheckError('source_layout_changed');
    await page.goto(new URL(href, page.url()).href);
    await page.getByRole('heading', { name: /Student, Sample/ }).waitFor();
    return parseAttendance(await page.locator('#content-main').innerText());
  }
  const absences = await attendance(absenceURL);
  const tardies = await attendance(tardyURL);
  for (const c of courses) {
    if (!c.detail) { c.missing = []; continue; }
    await page.goto(new URL(c.detail, sites.source.origin + '/guardian/').href);
    await page.getByRole('heading', { name: 'Class Score Detail: Student, Sample', exact: true }).waitFor();
    // Wait for Angular's published-assignment table or explicit empty result.
    try {
      await page.waitForFunction(() => document.querySelector('table [role="grid"]') || /No assignments/i.test(document.querySelector('#content-main')?.innerText || ''), null, { timeout: 5000 });
    } catch {
      c.missing = null; c.assignmentStatus = 'published_assignments_unavailable'; delete c.detail; continue;
    }
    c.missing = await page.locator('tr[id^="assignmentsection_"]').evaluateAll(rows => rows
      .filter(r => r.querySelector('.tt-missing'))
      .map(r => ({ due: r.cells[0].innerText, assignment: r.cells[2].innerText,
        score: r.querySelector('.score')?.innerText, excluded: !!r.querySelector('.tt-excluded') })));
    delete c.detail;
  }
  return { student: 'Sample Student', checkedAt: new Date().toISOString(), courses, absences, tardies };
}
