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
<section id="connections"><h2>School connections</h2>
<p>Connect your parent accounts to find their linked children. Confirm the child you want to monitor.</p>
<p>Your credentials are encrypted in this private service and used by hosted runners to sign in to the selected school portal. Disconnect to delete the saved credentials.</p>
<p id="connection-status" role="status" aria-live="polite"></p><div id="connection-list"></div></section>
<section id="report-recipients" hidden aria-labelledby="recipient-heading">
<h2 id="recipient-heading">Report recipients</h2>
<p>Choose who you want to share this child’s grades, assignments and attendance with.</p>
<p id="recipient-delivery">Loading email delivery status…</p>
<form id="recipient-form" method="post" action="/api/pilot/report-recipients" aria-label="Report recipients">
<fieldset id="recipient-fields" disabled><legend>Email addresses</legend>
<label for="recipient-emails">Recipients for this child</label>
<p id="recipient-help">Enter up to 10 email addresses, one per line or separated by commas. Leave the list empty to remove all recipients.</p>
<textarea id="recipient-emails" name="recipients" rows="4" maxlength="3000" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="recipient-help" placeholder="child@example.com&#10;partner@example.com"></textarea>
<button id="recipient-save" type="submit">Save recipients</button></fieldset></form>
<button id="recipient-reload" type="button">Reload saved list</button>
<p id="recipient-status" role="status" aria-live="polite"></p></section>
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
textarea{font:inherit;display:block;width:100%;min-height:8rem;padding:.6rem;border:1px solid #54758d;border-radius:.3rem;resize:vertical}fieldset{border:1px solid #cad9e4;padding:1rem;margin:1rem 0}legend{font-weight:700}form label{display:block;margin-top:.75rem}input{display:block;font:inherit;min-height:3rem;padding:.5rem;border:1px solid #54758d;border-radius:.3rem;width:min(100%,28rem)}form button{margin:1rem .6rem 0 0}form p{font-size:.95rem}.candidate{padding:.8rem 0;border-top:1px solid #cad9e4}.candidate label{display:block}.candidate select{display:block;margin:.5rem 0}.connection{border-top:1px solid #cad9e4;padding-top:1rem;margin-top:1rem}
`;

export function pilotClient() {
  const byId = id => document.getElementById(id);
  const status = text => { byId('status').textContent = text; };
  let invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (location.hash) history.replaceState(null, '', location.pathname);
  let generation = 0;
  let selectionWrites = Promise.resolve();
  let recipientView = null;
  let connectionTimer = null; let cachedChildren = []; const connectionViews = new Map();
  async function api(path, body) {
    const response = await fetch(`/api/pilot/${path}`, {
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
  function section(title) { const el = node('section', '', byId('report')); node('h2', title, el); return el; }
  function date(value) {
    if (!value) return 'Not checked';
    const local = new Date(value).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
    });
    return `${local} Seattle`;
  }
  const connectionMessage = reason => ({
    credentials_required: 'Enter your parent username and password.',
    check_needs_attention: 'A scheduled check needs your attention. Reconnect this account to verify sign-in and child selection.',
    try_again_later: 'Please wait a minute before trying another sign-in.',
    discovery_in_progress: 'A sign-in check is already in progress.',
    discovery_expired: 'The check timed out. Try again when the connection is available.',
    child_discovery_layout_unverified: 'We signed in but could not verify the child menu. The pilot organizer needs to check this portal layout.',
    child_identity_unverified: 'We could not verify which child was selected. No child was added.',
    child_identity_ambiguous: 'The portal shows ambiguous child identities. No child was added.',
    interactive_sso_required: 'This account needs a district sign-in step that the hosted pilot does not support yet.',
    connection_not_available: 'This portal connection is not available yet.',
  }[reason] || 'Sign-in or child discovery needs attention. Check your parent credentials. If the portal requires MFA, CAPTCHA or account setup, contact the pilot organizer; this pilot cannot complete those steps.');

  async function reloadChildren() {
    const current = byId('child').value;
    cachedChildren = (await api('children')).children;
    byId('child').replaceChildren(new Option('Choose a child', ''));
    for (const child of cachedChildren) byId('child').add(new Option(child.displayName, child.id));
    byId('child').value = cachedChildren.some(c => c.id === current) ? current : '';
  }
  function connectionCard(connection) {
    const provider = connection.provider;
    const title = provider === 'source' ? 'The Source' : 'Schoology';
    const view = connectionViews.get(provider);
    const signature = JSON.stringify([connection, connection.candidates.length ? cachedChildren : []]);
    if (view?.signature === signature) return;
    const root = document.createElement('div'); root.className = 'connection';
    if (view) view.element.replaceWith(root); else byId('connection-list').append(root);
    connectionViews.set(provider, { element: root, signature });
    node('h3', title, root);
    const pending = ['queued', 'discovering'].includes(connection.status);
    node('p', ({ not_connected: 'Not connected', queued: 'Waiting to check your account…', discovering: 'Signing in and checking linked children…',
      ready: 'Account verified. Confirm a linked child below.', attention: connectionMessage(connection.reason), disconnected: 'Disconnected. Saved credentials were deleted.' })[connection.status], root);
    if (!connection.available) node('p', 'This portal is not available for new connections yet. No password is collected here.', root);
    if (connection.available && !pending) {
      const holder = connection.status === 'ready' ? node('details', '', root) : root;
      if (holder !== root) node('summary', 'Reconnect account', holder);
      const form = node('form', '', holder); form.method = 'post'; form.action = `/api/pilot/connections/${provider}/connect`;
      form.setAttribute('aria-label', `Connect ${title}`);
      const fieldset = node('fieldset', '', form); node('legend', `${title} parent sign-in`, fieldset);
      const usernameId = `${provider}-username`; const passwordId = `${provider}-password`;
      const label = node('label', provider === 'schoology' ? 'Parent email' : 'Parent username', fieldset); label.htmlFor = usernameId;
      const username = node('input', '', fieldset); username.id = usernameId; username.name = 'username'; username.type = provider === 'schoology' ? 'email' : 'text';
      username.autocomplete = 'username'; username.autocapitalize = 'none'; username.spellcheck = false; username.required = true; username.maxLength = 254;
      const plabel = node('label', 'Password', fieldset); plabel.htmlFor = passwordId;
      const password = node('input', '', fieldset); password.id = passwordId; password.name = 'password'; password.type = 'password'; password.autocomplete = 'current-password'; password.required = true; password.maxLength = 2048;
      const submit = node('button', 'Find linked children', fieldset); submit.type = 'submit';
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true;
        const input = { username: username.value, password: password.value }; password.value = '';
        try { await api(`connections/${provider}/connect`, input); byId('connection-status').textContent = 'Account check requested. This can take a few minutes.'; await loadConnections(); }
        catch (error) { byId('connection-status').textContent = connectionMessage(error.message); }
        finally { input.password = ''; password.value = ''; submit.disabled = false; }
      });
    }
    for (const candidate of connection.candidates) {
      const row = node('div', '', root); row.className = 'candidate'; node('strong', candidate.displayName, row);
      if (candidate.linkedChildId) { node('p', 'Added to your family’s child list.', row); continue; }
      const label = node('label', `How should we add ${candidate.displayName}?`, row);
      const select = node('select', '', row); select.id = `candidate-${candidate.id}`; label.htmlFor = select.id;
      select.add(new Option('Add as a new child', ''));
      for (const child of cachedChildren) select.add(new Option(`Same child as ${child.displayName}`, child.id));
      node('p', 'Choose an existing child only if you recognize both portal records as the same person. Names alone are not matched automatically.', row);
      const button = node('button', 'Confirm child', row); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const saved = await api(`connections/${provider}/confirm`, { candidateId: candidate.id, childId: select.value || undefined });
          await reloadChildren(); byId('child').value = saved.childId; await loadReport(true); await loadConnections();
          byId('connection-status').textContent = `${candidate.displayName} was added. You can choose this child above.`;
        } catch (error) {
          byId('connection-status').textContent = error.message === 'child_provider_conflict'
            ? 'That child already has a different record in this portal. Add this as a new child, or choose the correct existing child.'
            : 'We could not confirm this child. Refresh the account check and try again.';
        }
        finally { button.disabled = false; }
      });
    }
    if (connection.status !== 'not_connected' && connection.status !== 'disconnected') {
      const disconnect = node('button', `Disconnect ${title}`, root); disconnect.type = 'button';
      disconnect.addEventListener('click', async () => {
        disconnect.disabled = true;
        try { await api(`connections/${provider}/disconnect`, {}); await loadConnections(); }
        catch { byId('connection-status').textContent = 'We could not disconnect this account. Try again.'; }
        finally { disconnect.disabled = false; }
      });
    }
  }
  async function loadConnections() {
    clearTimeout(connectionTimer);
    try {
      const data = await api('connections');
      for (const connection of data.connections) connectionCard(connection);
      if (data.connections.some(c => ['queued', 'discovering'].includes(c.status))) connectionTimer = setTimeout(loadConnections, 3000);
    } catch { byId('connection-status').textContent = 'Connection status is unavailable. Refresh the page before entering credentials.'; }
  }
  function items(title, list, parent) {
    node('h3', title, parent);
    if (list === null || list === undefined) { node('p', 'This information is unavailable.', parent); return; }
    if (!list.length) { node('p', 'No items in this saved section. This does not prove there is no homework.', parent); return; }
    const ul = node('ul', '', parent);
    for (const item of list) {
      const li = node('li', '', ul);
      let link = null;
      try {
        const url = new URL(item.url);
        if (url.origin === 'https://app.schoology.com') { link = node('a', item.assignment, li); link.href = url.href; link.rel = 'noreferrer'; }
      } catch { /* No safe direct link is available. */ }
      if (!link) node('span', item.assignment, li);
      if (item.course) node('span', ` — ${item.course}`, li);
      if (item.description) node('p', item.description, li);
      if (item.alsoListedOverdue) node('p', 'Submitted; Schoology also lists this overdue. Confirm the conflicting status rather than redo it.', li);
    }
  }
  function render(data) {
    byId('report').replaceChildren();
    const source = data.report.source;
    const summary = section(`${data.child.displayName}’s saved school update`);
    node('p', 'These are saved records, not a live portal session. When hosted checks are enabled and a connection is ready, confirmed children are checked on weekdays after 5 p.m. Seattle time, except configured closure dates, plus an initial check when connected. Check the verification times below.', summary);
    for (const p of data.providers) {
      node('h3', p.provider === 'source' ? 'The Source' : 'Schoology', summary);
      node('p', `Last verified: ${date(p.observedAt)}. Latest attempt: ${date(p.lastAttemptAt)}.`, summary);
      if (p.lastStatus !== 'ok') node('p', p.lastStatus === 'not_checked' ? 'No check has been recorded.' : 'The latest check did not succeed. Earlier verified records below may be out of date.', summary).className = 'warning';
      else if (Date.parse(data.report.cutoff) - Date.parse(p.observedAt) > 86400000) {
        node('p', 'This observation is more than a day old. Deadlines and assignment status may have changed.', summary).className = 'warning';
      }
    }
    if (source) {
      const grades = section('Semester grades and Source missing work');
      const wrap = node('div', '', grades); wrap.className = 'table-wrap'; wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Course grades');
      const table = node('table', '', wrap); node('caption', `Last verified ${date(source.observedAt)}`, table);
      const head = node('tr', '', node('thead', '', table));
      for (const title of ['Course', 'Semester grade', 'Missing flags']) node('th', title, head).scope = 'col';
      const tbody = node('tbody', '', table);
      for (const course of source.courses) {
        const row = node('tr', '', tbody);
        node('th', course.course, row).scope = 'row';
        const grade = course.semester || 'Unavailable';
        node('td', /^[A-D][+-]?\s+0$/.test(grade) ? `${grade.split(/\s/)[0]} (percentage inconsistent)` : grade, row);
        node('td', course.missing === null ? 'Unknown' : String(course.missing.length), row);
        if (course.missing?.length) {
          const details = node('details', '', grades); node('summary', `${course.course}: missing assignments`, details);
          const ul = node('ul', '', details);
          for (const a of course.missing) node('li', `${a.assignment} — due ${a.due || 'date unavailable'}; recorded ${a.score || 'score unavailable'}`, ul);
        }
      }
      node('p', 'Partial credit does not establish completion or late-work eligibility. A conflicting percentage should be confirmed with the teacher.', grades);
      const attendance = section('Attendance recorded by Source');
      node('p', 'Each entry represents one class period. ME is medical excused; EA is excused absent; UA/UL are explicitly unexcused. A/L have unspecified excusal status.', attendance);
      const list = [...(source.attendance?.absences ?? []), ...(source.attendance?.tardies ?? [])].sort((a, b) => b.date.localeCompare(a.date));
      const ul = node('ul', '', attendance);
      for (const a of list.slice(0, 20)) node('li', `${a.date} — period ${a.period}: ${a.code}`, ul);
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
  function recipientMessage(error) {
    return ({ invalid_email_address: 'Check each email address. Use addresses only, without names or extra text.',
      too_many_recipients: 'Enter no more than 10 email addresses.',
      recipient_settings_changed: 'This saved list changed in another window. Keep a copy of your edits, then reload the saved list before saving again.',
      sign_in_required: 'Your sign-in has expired. Sign in again to edit recipients.',
    })[error.message] || 'We could not save these recipients. Your edits are still here. Try again.';
  }
  function renderDelivery(delivery) {
    const messages = { sent: 'Accepted by the email service; inbox delivery is not confirmed.',
      failed: 'The latest report could not be sent.', unknown: 'The latest delivery could not be confirmed. It will not be resent automatically.',
      retry: 'The email service was busy; a limited retry is scheduled.', sending: 'The latest report is being sent.',
      skipped: 'The latest report was skipped because delivery settings changed.' };
    byId('recipient-delivery').textContent = delivery?.status === 'enabled'
      ? `Email delivery starts ${delivery.startDate}: weekdays after the 5 p.m. Seattle check, except configured closure dates. Save an empty list to stop emails for this child.${delivery.latest ? ` Latest report (${delivery.latest.check_date}): ${messages[delivery.latest.state] ?? 'status unavailable'}` : ''}`
      : 'Email delivery is not enabled yet. You can save your list now.';
  }
  async function loadRecipients(childId) {
    if (recipientView?.childId === childId && recipientView.loaded) return;
    const view = { childId, revision: null, loaded: false }; recipientView = view;
    byId('report-recipients').hidden = !childId;
    byId('recipient-fields').disabled = true;
    byId('recipient-save').disabled = false; byId('recipient-reload').disabled = false;
    byId('recipient-emails').value = '';
    byId('recipient-delivery').textContent = 'Loading email delivery status…';
    if (!childId) return;
    const child = cachedChildren.find(value => value.id === childId);
    byId('recipient-heading').textContent = `Report recipients for ${child?.displayName ?? 'this child'}`;
    byId('recipient-status').textContent = 'Loading saved recipients…';
    try {
      const data = await api(`report-recipients?childId=${encodeURIComponent(childId)}`);
      if (recipientView !== view || byId('child').value !== childId) return;
      view.revision = data.revision; view.loaded = true; renderDelivery(data.delivery);
      byId('recipient-emails').value = data.recipients.join('\n');
      byId('recipient-status').textContent = data.recipients.length ? 'Saved recipients loaded.' : 'No recipients saved for this child.';
      byId('recipient-fields').disabled = false;
    } catch {
      if (recipientView === view) byId('recipient-status').textContent = 'We could not load saved recipients. Reload the saved list before editing.';
    }
  }
  byId('recipient-form').addEventListener('submit', async event => {
    event.preventDefault();
    const view = recipientView;
    if (!view?.loaded || view.conflict || byId('child').value !== view.childId) return;
    const recipients = byId('recipient-emails').value.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
    byId('recipient-fields').disabled = true;
    byId('recipient-reload').disabled = true;
    byId('recipient-status').textContent = 'Saving recipients…';
    try {
      const data = await api('report-recipients', { childId: view.childId, recipients, revision: view.revision });
      if (recipientView !== view) return;
      view.revision = data.revision;
      byId('recipient-emails').value = data.recipients.join('\n');
      renderDelivery(data.delivery);
      byId('recipient-status').textContent = data.delivery?.status === 'enabled'
        ? 'Recipients saved. Future reports will use this list.' : 'Recipients saved. Email delivery is not enabled yet.';
    } catch (error) {
      if (recipientView === view) {
        byId('recipient-status').textContent = recipientMessage(error);
        if (error.message === 'recipient_settings_changed') view.conflict = true;
      }
    } finally {
      if (recipientView === view) {
        byId('recipient-fields').disabled = !view.loaded;
        byId('recipient-save').disabled = Boolean(view.conflict); byId('recipient-reload').disabled = false;
      }
    }
  });
  byId('recipient-reload').addEventListener('click', () => {
    recipientView = null; loadRecipients(byId('child').value).catch(() => status('We could not reload recipients. Please refresh the page.'));
  });
  async function loadReport(save = false) {
    const version = ++generation;
    byId('report').replaceChildren();
    const childId = byId('child').value;
    if (recipientView?.childId !== childId) {
      recipientView = null; byId('report-recipients').hidden = true;
      byId('recipient-fields').disabled = true; byId('recipient-emails').value = '';
    }
    if (!childId) { await loadRecipients(''); status('Choose a child to see saved school records.'); return; }
    status('Loading saved school records…');
    try {
      if (save) {
        const write = selectionWrites.catch(() => null).then(() => api('selection', { childId }));
        selectionWrites = write;
        await write;
      }
      if (version !== generation) return;
      loadRecipients(childId).catch(() => {
        if (byId('child').value === childId) byId('recipient-status').textContent = 'We could not load saved recipients. Reload the saved list before editing.';
      });
      const data = await api(`report?childId=${encodeURIComponent(childId)}`);
      if (version !== generation) return;
      render(data); status('Saved report loaded. Check the verification times below.');
    } catch { if (version === generation) status('We could not load this report. Refresh the page to check your access.'); }
  }
  async function start() {
    try {
      if (invitation) { byId('welcome').hidden = false; status('Confirm your invitation to continue.'); return; }
      const session = await api('session');
      const data = await api('children');
      cachedChildren = data.children;
      byId('account').textContent = `Signed in as ${session.email}`;
      byId('family').hidden = false;
      await loadConnections();
      byId('child').replaceChildren(new Option('Choose a child', ''));
      for (const child of data.children) byId('child').add(new Option(child.displayName, child.id));
      if (!data.children.length) { status('Your family account is ready. Connect a school account below to find your linked children.'); return; }
      byId('child').value = data.children.some(c => c.id === session.selectedChildId) ? session.selectedChildId : '';
      await loadReport();
    } catch (error) {
      const messages = { invitation_required: 'You need a family invitation to continue. Ask the pilot organizer for a new link.',
        sign_in_required: 'Your sign-in has expired. Open the app again to receive a new login code.',
        pilot_not_configured: 'The pilot is not ready for sign-in yet. Please return after setup is complete.' };
      status(messages[error.message] || 'We could not open your family account. Please try again later.');
    }
  }
  byId('accept').addEventListener('click', async () => {
    byId('accept').disabled = true;
    try { await api('invitation', { token: invitation }); invitation = null; byId('welcome').hidden = true; await start(); }
    catch { status('This invitation is unavailable. Sign in with the invited email or ask for a new invitation.'); }
    finally { byId('accept').disabled = false; }
  });
  byId('child').addEventListener('change', () => loadReport(true));
  byId('refresh').addEventListener('click', () => loadReport());
  start().catch(() => status('We could not start the dashboard. Please refresh the page.'));
}
