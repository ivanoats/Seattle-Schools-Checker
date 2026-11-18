// A deliberately small shell: no third-party scripts, fonts or student data.
export const pilotHtml = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>School check-in</title><link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script></head><body>
<a class="skip" href="#main">Skip to school update</a>
<header><a href="/app" class="brand">School check-in</a><a href="/cdn-cgi/access/logout">Sign out</a></header>
<main id="main"><h1>A clearer picture of the school week.</h1>
<p class="intro">Assignments, grades and attendance, with room to check what the records don’t tell us.</p>
<p id="status" role="status" aria-live="polite">Checking your access…</p>
<section id="welcome" hidden><h2>Welcome to your family’s space</h2>
<p>This invitation connects your verified email to a private family account.</p>
<button id="accept" type="button">Accept invitation</button></section>
<div id="family" hidden><p id="account"></p>
<section class="picker"><label for="child">Whose week are we looking at?</label>
<select id="child"><option value="">Choose a child</option></select>
<button id="refresh" type="button">Refresh saved report</button></section>
<section id="connections"><h2>School connections</h2><p>Account connections are not available in this pilot build yet. No school passwords are collected here.</p>
<p>Once connections are available, you’ll sign in to each parent account and confirm your linked child here.</p></section>
<div id="report"></div></div>
<p class="footnote">Source missing flags and Schoology overdue labels mean different things. Check turn-in evidence before redoing work.</p>
</main></body></html>`;

export const pilotCss = `
:root{font-family:"Avenir Next",Avenir,"Trebuchet MS",sans-serif;color:#17334c;background:#f0f6fb;line-height:1.6;color-scheme:light}
*{box-sizing:border-box}body{margin:0}header{background:#17334c;color:white;padding:1.2rem max(1.25rem,calc((100vw - 65rem)/2));display:flex;justify-content:space-between;gap:1rem}
header a{color:white}.brand{font-size:1.2rem;font-weight:700;text-decoration:none}main{max-width:65rem;margin:auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.12;letter-spacing:-.035em;max-width:18ch;margin:.5rem 0 1rem}
h2{font-size:1.4rem;line-height:1.3}h3{font-size:1.1rem}p{max-width:74ch}.intro{font-size:1.15rem;max-width:54ch;color:#3b5670}
section{margin:1.6rem 0;padding:1.4rem;background:white;border-radius:.45rem;border-left:4px solid #5685a8}
.picker{display:flex;align-items:center;flex-wrap:wrap;gap:1rem;background:#dceaf5;border:0}.picker label{font-weight:700}
select,button{font:inherit;min-height:2.8rem;padding:.5rem .9rem;border:1px solid #54758d;border-radius:.3rem;max-width:100%}
button{background:#1b577e;color:white;cursor:pointer}button:disabled{opacity:.65;cursor:wait}select{background:white;color:#17334c}
a{color:#145b84;text-underline-offset:.2em}:focus-visible{outline:3px solid #a26500;outline-offset:4px}.skip{position:absolute;top:-5rem;background:white;padding:1rem}.skip:focus{top:0}
#status{padding:.7rem 0;font-weight:600}li{margin:.5rem 0}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:.65rem;border-bottom:1px solid #cad9e4;vertical-align:top}
caption{text-align:left;font-weight:700;padding:.5rem 0}.table-wrap{overflow:auto}.footnote{color:#456079;font-size:.95rem;margin-top:2rem}
.verified{color:#275c3c}.warning{color:#80501a}[hidden]{display:none!important}@media(max-width:36rem){main{padding-top:1.4rem}section{padding:1rem}.picker{display:block}.picker select,.picker button{display:block;width:100%;margin-top:.8rem}th,td{padding:.5rem}}
`;

export function pilotClient() {
  const $ = id => document.getElementById(id);
  const status = text => { $('status').textContent = text; };
  let invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (location.hash) history.replaceState(null, '', location.pathname);
  let generation = 0;
  let selectionWrites = Promise.resolve();
  async function api(path, body) {
    const response = await fetch('/api/pilot/' + path, {
      credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pilot-Request': '1' }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.status);
    return data;
  }
  function node(tag, text, parent) {
    const el = document.createElement(tag); el.textContent = text; parent?.append(el); return el;
  }
  function section(title) { const el = node('section', '', $('report')); node('h2', title, el); return el; }
  function date(value) { return value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' Seattle' : 'Not checked'; }
  function items(title, list, parent) {
    node('h3', title, parent);
    if (list === null || list === undefined) { node('p', 'This information is unavailable.', parent); return; }
    if (!list.length) { node('p', 'No items in this saved section. This does not prove there is no homework.', parent); return; }
    const ul = node('ul', '', parent);
    for (const item of list) {
      const li = node('li', '', ul);
      let link;
      try {
        const url = new URL(item.url);
        if (url.origin === 'https://app.schoology.com') { link = node('a', item.assignment, li); link.href = url.href; link.rel = 'noreferrer'; }
      } catch { /* No safe direct link is available. */ }
      if (!link) node('span', item.assignment, li);
      if (item.course) node('span', ' — ' + item.course, li);
      if (item.description) node('p', item.description, li);
      if (item.alsoListedOverdue) node('p', 'Submitted; Schoology also lists this overdue. Confirm the conflicting status rather than redo it.', li);
    }
  }
  function render(data) {
    $('report').replaceChildren();
    const source = data.report.source;
    const summary = section(data.child.displayName + '’s saved school update');
    node('p', 'These are saved records, not a live portal session. All times below are Seattle time.', summary);
    for (const p of data.providers) {
      node('h3', p.provider === 'source' ? 'The Source' : 'Schoology', summary);
      node('p', 'Last verified: ' + date(p.observedAt) + '. Latest attempt: ' + date(p.lastAttemptAt) + '.', summary);
      if (p.lastStatus !== 'ok') node('p', p.lastStatus === 'not_checked' ? 'No check has been recorded.' : 'The latest check did not succeed. Earlier verified records below may be out of date.', summary).className = 'warning';
      else if (Date.parse(data.report.cutoff) - Date.parse(p.observedAt) > 86400000) {
        node('p', 'This observation is more than a day old. Deadlines and assignment status may have changed.', summary).className = 'warning';
      }
    }
    if (source) {
      const grades = section('Semester grades and Source missing work');
      const wrap = node('div', '', grades); wrap.className = 'table-wrap'; wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Course grades');
      const table = node('table', '', wrap); node('caption', 'Last verified ' + date(source.observedAt), table);
      const head = node('tr', '', node('thead', '', table));
      for (const title of ['Course', 'Semester grade', 'Missing flags']) node('th', title, head).scope = 'col';
      const tbody = node('tbody', '', table);
      for (const course of source.courses) {
        const row = node('tr', '', tbody);
        node('th', course.course, row).scope = 'row';
        const grade = course.semester || 'Unavailable';
        node('td', /^[A-D][+-]?\s+0$/.test(grade) ? grade.split(/\s/)[0] + ' (percentage inconsistent)' : grade, row);
        node('td', course.missing === null ? 'Unknown' : String(course.missing.length), row);
        if (course.missing?.length) {
          const details = node('details', '', grades); node('summary', course.course + ': missing assignments', details);
          const ul = node('ul', '', details);
          for (const a of course.missing) node('li', a.assignment + ' — due ' + (a.due || 'date unavailable') + '; recorded ' + (a.score || 'score unavailable'), ul);
        }
      }
      node('p', 'Partial credit does not establish completion or late-work eligibility. A conflicting percentage should be confirmed with the teacher.', grades);
      const attendance = section('Attendance recorded by Source');
      node('p', 'Each entry represents one class period. ME is medical excused; EA is excused absent; UA/UL are explicitly unexcused. A/L have unspecified excusal status.', attendance);
      const list = [...(source.attendance?.absences ?? []), ...(source.attendance?.tardies ?? [])].sort((a, b) => b.date.localeCompare(a.date));
      const ul = node('ul', '', attendance);
      for (const a of list.slice(0, 20)) node('li', a.date + ' — period ' + a.period + ': ' + a.code, ul);
      if (list.length > 20) node('p', 'Showing the 20 most recent class-period entries.', attendance);
      if (!list.length) node('p', 'No attendance entries in this saved observation.', attendance);
    }
    if (data.report.schoology) {
      const school = section('Schoology: what to check next');
      items('Submitted; awaiting grading', data.report.schoology.awaitingGrade, school);
      items('Due later today', data.report.schoology.dueToday, school);
      items('Upcoming at last verified check', data.report.schoology.upcoming, school);
      items('Overdue label; confirm turn-in', data.report.schoology.confirmTurnIn, school);
      items('Conflicting deadline information', data.report.schoology.conflictingDeadlines, school);
    }
  }
  async function loadReport(save = false) {
    const version = ++generation;
    $('report').replaceChildren();
    const childId = $('child').value;
    if (!childId) { status('Choose a child to see saved school records.'); return; }
    status('Loading saved school records…');
    try {
      if (save) {
        const write = selectionWrites.catch(() => {}).then(() => api('selection', { childId }));
        selectionWrites = write;
        await write;
      }
      if (version !== generation) return;
      const data = await api('report?childId=' + encodeURIComponent(childId));
      if (version !== generation) return;
      render(data); status('Saved report loaded. Check the verification times below.');
    } catch { if (version === generation) status('We could not load this report. Refresh the page to check your access.'); }
  }
  async function start() {
    try {
      if (invitation) { $('welcome').hidden = false; status('Confirm your invitation to continue.'); return; }
      const session = await api('session');
      const data = await api('children');
      $('account').textContent = 'Signed in as ' + session.email;
      $('family').hidden = false;
      $('child').replaceChildren(new Option('Choose a child', ''));
      for (const child of data.children) $('child').add(new Option(child.displayName, child.id));
      if (!data.children.length) { status('Your family account is ready. School connections must be enabled before children can be discovered.'); return; }
      $('child').value = data.children.some(c => c.id === session.selectedChildId) ? session.selectedChildId : '';
      await loadReport();
    } catch (error) {
      const messages = { invitation_required: 'You need a family invitation to continue. Ask the pilot organizer for a new link.',
        sign_in_required: 'Your sign-in has expired. Open the app again to receive a new login code.',
        pilot_not_configured: 'The pilot is not ready for sign-in yet. Please return after setup is complete.' };
      status(messages[error.message] || 'We could not open your family account. Please try again later.');
    }
  }
  $('accept').addEventListener('click', async () => {
    $('accept').disabled = true;
    try { await api('invitation', { token: invitation }); invitation = null; $('welcome').hidden = true; await start(); }
    catch { status('This invitation is unavailable. Sign in with the invited email or ask for a new invitation.'); }
    finally { $('accept').disabled = false; }
  });
  $('child').addEventListener('change', () => loadReport(true));
  $('refresh').addEventListener('click', () => loadReport());
  start();
}
