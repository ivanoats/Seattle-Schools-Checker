import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { configuredChild } from '../src/core/children.js';
import { readSource } from '../src/source.js';
import { readSchoology } from '../src/schoology.js';
import { compareMissing, compareSemesterGrades, observeSchool } from '../src/core/observations.js';
import { buildFamilyReport } from '../src/core/family-report.js';

const config = {
  defaultChild: 'alex-one',
  children: ['One', 'Two'].map((surname, index) => ({
    id: `alex-${surname.toLowerCase()}`,
    displayName: `Alex ${surname}`,
    providers: {
      source: { tabLabel: 'Alex', tabHref: `/guardian/home.html?student=${index + 1}`,
        studentHeading: `${surname}, Alex`, term: '2026-S1' },
      schoology: { banner: `You are viewing as Alex ${surname}` },
    },
  })),
};
const [one, two] = config.children;
const friday = '2026-11-06T23:00:00Z';
const nextFriday = '2026-11-14T01:00:00Z';
const cutoff = '2026-11-14T01:05:00Z';
const item = { assignment: 'Shared title', due: '11/05/2026', score: '5/10' };
const course = { course: 'Math', period: '1', semester: 'B\n84' };

function sourceObservation(child, time, missing, rows = null) {
  return observeSchool({ child, provider: 'source', observedAt: time,
    report: { student: child.displayName, courses: [{ ...course, missing }], absences: [], tardies: [] },
    assignmentRows: [rows],
  });
}

test('configuration uses a stable child key and rejects ambiguous identity and external tab links', () => {
  assert.equal(configuredChild(config), one);
  assert.equal(configuredChild(config, two.id), two);
  assert.throws(() => configuredChild(config, 'absent'), /child_not_configured/);
  const invalid = structuredClone(config);
  invalid.children[1].providers.source.studentHeading = one.providers.source.studentHeading;
  assert.throws(() => configuredChild(invalid), /invalid_child_config/);
  invalid.children[1].providers.source.studentHeading = two.providers.source.studentHeading;
  invalid.children[1].providers.source.tabHref = '//outside.invalid/guardian/home.html';
  assert.throws(() => configuredChild(invalid), /invalid_child_config/);
});

test('both portal adapters return the intended child with overlapping names and assignments', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(700);
    let schoologyChild = one;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const number = url.searchParams.get('student');
      const selected = number === '2' ? two : one;
      const name = selected.providers.source.studentHeading;
      const score = number === '2' ? '8/10' : '5/10';
      let body;
      if (url.hostname === 'app.schoology.com') {
        body = `<div id="child-session-banner">${schoologyChild.providers.schoology.banner}</div>
          <div id="right-column-inner"><div id="overdue-submissions">
          <div class="upcoming-event"><span class="event-title"><a href="/assignment/123">Shared title</a></span>
          ${schoologyChild.id}</div></div></div>`;
      } else if (url.pathname.endsWith('/attendance.html')) {
        body = `<h1>Attendance: ${name}</h1><div id="content-main">1 - 11/05/2026 - A</div>`;
      } else if (url.pathname.endsWith('/detail.html')) {
        body = `<h1>Class Score Detail: ${name}</h1><table><tbody role="grid">
          <tr id="assignmentsection_1"><td>11/05/2026</td><td></td><td>Shared title</td>
          <td class="score">${score}</td><td><span class="tt-missing"></span></td></tr></tbody></table>`;
      } else {
        const cells = Array(20).fill('');
        cells[0] = '1';
        cells[11] = 'Math';
        cells[14] = `<a href="/guardian/detail.html?student=${number}">B</a>`;
        body = `<a href="${one.providers.source.tabHref}">Alex</a>
          <a href="${two.providers.source.tabHref}">Alex</a><h1>Grades: ${name}</h1>
          <table id="tblgrades"><tr id="course-1">${cells.map(cell => `<td>${cell}</td>`).join('')}</tr></table>
          <div id="tblgrades"><a href="/guardian/attendance.html?codes=*abs&student=${number}">Absences</a>
          <a href="/guardian/attendance.html?codes=*tar&student=${number}">Tardies</a></div>`;
      }
      return route.fulfill({ contentType: 'text/html', body });
    });
    const ambiguous = structuredClone(one);
    delete ambiguous.providers.source.tabHref;
    await assert.rejects(readSource(page, ambiguous), { status: 'source_child_tab_unverified' });
    for (const [child, score] of [[one, '5/10'], [two, '8/10']]) {
      const source = await readSource(page, child);
      assert.equal(source.student, child.displayName);
      assert.equal(source.courses[0].missing[0].score, score);
      schoologyChild = child;
      const schoology = await readSchoology(page, child);
      assert.equal(schoology.student, child.displayName);
      assert.match(schoology.overdue[0].description, new RegExp(child.id));
      assert.equal(schoology.upcoming, null);
    }
  } finally { await browser.close(); }
});

test('missing changes require same-child, same-term evidence and a visible row to clear', () => {
  const baseline = sourceObservation(one, friday, [item]);
  const otherChild = sourceObservation(two, nextFriday, []);
  assert.equal(compareMissing(otherChild, baseline).status, 'baseline_unavailable');
  const wrongTerm = { ...otherChild, childId: one.id, term: '2026-S2' };
  assert.equal(compareMissing(wrongTerm, baseline).status, 'baseline_unavailable');

  for (const current of [
    sourceObservation(one, nextFriday, null),
    sourceObservation(one, nextFriday, [], []),
    { ...sourceObservation(one, nextFriday, []), courses: [] },
  ]) {
    const changes = compareMissing(current, baseline);
    assert.equal(changes.status, 'partial');
    assert.deepEqual(changes.cleared, []);
  }
  const current = sourceObservation(one, nextFriday, [], [{ ...item, missing: false }]);
  assert.equal(compareMissing(current, baseline).cleared[0].assignment, item.assignment);
  const newItem = { ...item, assignment: 'Newly missing' };
  assert.deepEqual(compareMissing(sourceObservation(one, nextFriday, [item, newItem]), baseline)
    .added.map(row => row.assignment), [newItem.assignment]);
  current.courses[0].semester = 'A-\n91';
  assert.deepEqual(compareSemesterGrades(current, baseline), [
    { course: 'Math', period: '1', from: 'B 84', to: 'A- 91' },
  ]);
  current.courses[0].semester = 'C+\n0';
  assert.deepEqual(compareSemesterGrades(current, baseline), []);
});

test('Friday model separates a receipt, an overdue flag, a future deadline and unavailable data', () => {
  const receipt = { course: 'Literature', assignment: 'Outline',
    url: 'https://app.schoology.com/course/12/preview/34/parent?url=assignment/123',
    submissionStatus: 'This material has been submitted but not yet graded' };
  const tonight = { course: 'Literature', assignment: 'Final essay',
    url: 'https://app.schoology.com/assignment/456', dateLabel: 'Due Friday at 11:59 pm',
    scheduledAt: '2026-11-14T07:59:00Z' };
  const past = { ...tonight, assignment: 'Earlier work', url: 'https://app.schoology.com/assignment/789',
    scheduledAt: '2026-11-13T07:59:00Z' };
  const schoology = observeSchool({ child: one, provider: 'schoology', observedAt: nextFriday,
    report: { student: one.displayName, upcoming: [tonight], events: null,
      overdue: [{ ...receipt, url: 'https://app.schoology.com/assignment/123' }, past, tonight],
      recentlyCompleted: [receipt] },
  });
  const source = sourceObservation(one, nextFriday, [item]);
  const model = buildFamilyReport({ childId: one.id, source, schoology, cutoff });
  assert.equal(model.source.courses[0].missing[0].assignment, item.assignment);
  assert.deepEqual(model.schoology.dueToday, [tonight]);
  assert.equal(model.schoology.awaitingGrade[0].alsoListedOverdue, true);
  assert.deepEqual(model.schoology.confirmTurnIn, [past]);
  assert.deepEqual(model.schoology.conflictingDeadlines, [tonight]);
  assert.equal(model.schoology.events, null);
  const unavailableUpcoming = buildFamilyReport({ childId: one.id, cutoff,
    schoology: { ...schoology, upcoming: null, overdue: [past] } });
  assert.equal(unavailableUpcoming.schoology.dueToday, null);
  assert.throws(() => buildFamilyReport({ childId: two.id, schoology, cutoff }), /invalid_report_observation/);
});
