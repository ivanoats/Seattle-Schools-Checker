import { sites } from '../../src/auth.js';

export const children = ['One', 'Two'].map((surname, index) => ({
  id: `synthetic-${index + 1}`,
  displayName: `Alex ${surname}`,
  providers: {
    source: { tabLabel: 'Alex', tabHref: `/guardian/home.html?student=${index + 1}`,
      studentHeading: `${surname}, Alex`, term: '2026-S1' },
    schoology: { banner: `You are viewing as Alex ${surname}` },
  },
}));

export const credentials = { username: 'guardian@fixture.invalid', password: 'synthetic-password' };

export const forms = {
  source: { action: '/guardian/login.html', user: 'fieldAccount', pass: 'fieldPassword',
    submit: 'btn-enter-sign-in', landing: '/guardian/home.html' },
  schoology: { action: '/login', user: 'edit-mail', pass: 'edit-pass',
    submit: 'edit-submit', landing: '/parent/home' },
};

function loginForm({ action, user, pass, submit }) {
  return `<form method="post" action="${action}">
    <input id="${user}" name="username" type="text">
    <input id="${pass}" name="password" type="password">
    <button id="${submit}" type="submit">Sign in</button>
  </form>`;
}

function sourcePage(url) {
  const number = url.searchParams.get('student') || '1';
  const heading = children[Number(number) - 1].providers.source.studentHeading;
  if (url.pathname.endsWith('/attendance.html')) {
    const entry = url.searchParams.get('codes') === '*abs' ? '1 - 11/05/2026 - A' : '1 - 11/06/2026 - L';
    return `<h1>Attendance: ${heading}</h1><div id="content-main">${entry}</div>`;
  }
  if (url.pathname.endsWith('/detail.html')) {
    const score = number === '1' ? '5/10' : '8/10';
    return `<h1>Class Score Detail: ${heading}</h1><table><tbody role="grid">
      <tr id="assignmentsection_1"><td>11/05/2026</td><td></td><td>Shared title</td>
      <td class="score">${score}</td><td><span class="tt-missing"></span></td></tr>
      <tr id="assignmentsection_2"><td>11/06/2026</td><td></td><td>Ungraded exercise</td>
      <td class="score">--</td><td><span hidden>Missing</span></td></tr>
    </tbody></table>`;
  }
  const cells = Array(20).fill('');
  cells[0] = '1';
  cells[11] = 'Math';
  cells[14] = `<a href="/guardian/detail.html?student=${number}">B</a>`;
  return `<button id="btnLogout">Sign out</button>
    ${children.map(child => `<a href="${child.providers.source.tabHref}">Alex</a>`).join('')}
    <h1>Grades: ${heading}</h1><table id="tblgrades"><tr id="course-1">
      ${cells.map(cell => `<td>${cell}</td>`).join('')}
    </tr><tr><td><a href="/guardian/attendance.html?codes=*abs&student=${number}">Absences</a>
    <a href="/guardian/attendance.html?codes=*tar&student=${number}">Tardies</a></td></tr></table>`;
}

function schoologyPage(child) {
  const overdue = `<div class="upcoming-event"><span class="event-title">
    <a href="/assignment/123">Shared title</a></span> ${child.id}</div>`;
  return `<div id="child-session-banner">${child.providers.schoology.banner}</div>
    <div id="right-column-inner">
      <div id="overdue-submissions">${overdue}</div>
      <button onclick="document.getElementById('overdue-popup').hidden = false">1 more overdue</button>
      <div id="overdue-popup" hidden>${overdue}
        <div class="upcoming-event" hidden><span class="event-title">
          <a href="/assignment/345">Hidden item</a></span></div>
      </div>
      <div class="upcoming-submissions"><div class="upcoming-event" data-start="1794643140">
        <span class="event-title"><a href="/assignment/456">Future work</a></span>
      </div></div>
      <section><h2>Recently Completed</h2><div class="recently-completed-event">
        <span class="recently-completed-title"><a href="/assignment/789">Outline</a></span>
        <span class="recently-completed-grade" aria-label="This material has been submitted but not yet graded"></span>
      </div></section>
    </div>`;
}

export function fixturePage(service, child, url, signedIn) {
  const { origin } = sites[service];
  if (url.origin !== origin) return null;
  if (!signedIn) return loginForm(forms[service]);
  return service === 'source' ? sourcePage(url) : schoologyPage(child);
}
