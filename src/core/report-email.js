import { assignmentIdentity, buildFamilyReport } from './family-report.js';

const localTime = value => value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'never verified';
const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ');
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function courseLines(course) {
  const missing = course.missing === null || (course.assignmentStatus && course.assignmentStatus !== 'available') ? null : course.missing;
  let grade = clean(course.semester) || 'grade unavailable';
  if (/^[A-D][+-]?\s+0(?:\.0+)?%?$/.test(grade)) grade = `${grade.split(/\s/)[0]} (displayed percentage inconsistent)`;
  const missingLabel=missing===null?'missing work unknown':`${missing.length} marked missing`;
  const lines = [`${clean(course.course)} (period ${clean(course.period) || '?'}): ${grade}; ${missingLabel}.`];
  for (const assignment of missing ?? []) lines.push(`  • ${clean(assignment.assignment)} — due ${clean(assignment.due) || 'date unavailable'}; recorded score ${clean(assignment.score) || 'unavailable'}.`);
  return lines;
}

function attendanceLines(attendance) {
  const lines = ['', 'ATTENDANCE — THE SOURCE'];
  for (const kind of ['absences', 'tardies']) {
    const entries = attendance?.[kind];
    if (!Array.isArray(entries)) { lines.push(`${kind}: unavailable.`); continue; }
    lines.push(`${kind}: ${entries.length} class-period entries, not days.`);
    for (const entry of [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40)) {
      lines.push(`  • ${clean(entry.date)} — period ${clean(entry.period)}: ${clean(entry.code)}`);
    }
    if (entries.length > 40) lines.push('Showing the 40 most recent entries in this category.');
  }
  lines.push('ME: medical excused. EA: excused absent. UA/UL: explicitly unexcused. A/L: excusal status unspecified.');
  return lines;
}

function itemMetadata(item) {
  const lines = [];
  if (item.dateLabel) lines.push(clean(item.dateLabel));
  if (item.scheduledAt) lines.push(`Displayed event time ${localTime(item.scheduledAt)} Seattle time`);
  for (const dueLine of (item.description ?? '').split('\n').filter(value => /^\s*Due\b/i.test(value))) lines.push(clean(dueLine));
  return lines;
}

function itemLines(item, signals = []) {
  const lines = [`  • ${clean(item.course)} — ${clean(item.assignment)}`];
  for (const metadata of itemMetadata(item)) lines.push(`    ${metadata}`);
  if (item.alsoListedOverdue) lines.push('    Also listed overdue—submission is verified; do not redo without checking.');
  if (item.submissionStatus) lines.push(`    ${clean(item.submissionStatus)}`);
  const seen = new Set(itemMetadata(item));
  for (const signal of signals) for (const metadata of itemMetadata(signal.item)) {
    if (!seen.has(metadata)) { lines.push(`    ${signal.label}: ${metadata}`); seen.add(metadata); }
  }
  if (item.url && item.url.startsWith('https://app.schoology.com/')) lines.push(`    ${item.url}`);
  return lines;
}

function submittedSignals(item, observation) {
  const identity = assignmentIdentity(item);
  if (!identity) return [];
  return [['Overdue listing', observation?.overdue], ['Upcoming listing', observation?.upcoming]]
    .flatMap(([label, items]) => (items ?? []).filter(value => assignmentIdentity(value) === identity).map(value => ({ label, item: value })));
}

function schoologyLines(school, observation) {
  const lines = ['', 'SCHOOLOGY'];
  if (!school) return [...lines, 'Unavailable. Turn-in status and deadlines are unknown.'];
  if (!['expanded_visible_list', 'complete'].includes(school.overdueCoverage)) lines.push(`Overdue coverage: ${clean(school.overdueCoverage) || 'unknown'}. An incomplete list does not mean work is clear.`);
  const submitted = new Set(school.awaitingGrade?.map(assignmentIdentity).filter(Boolean));
  const sections = [['Schoology confirms submitted; awaiting grading', 'awaitingGrade'], ['Due later today (Seattle time)', 'dueToday'],
    ['Upcoming at last verified check', 'upcoming'], ['Overdue label; confirm turn-in', 'confirmTurnIn'],
    ['Conflicting deadline signals; verify the actual deadline', 'conflictingDeadlines'], ['Calendar events (not automatically assignment deadlines)', 'events']];
  for (const [title, key] of sections) {
    lines.push('', title);
    const items = school[key]?.filter(item => !['upcoming', 'conflictingDeadlines'].includes(key) || !submitted.has(assignmentIdentity(item))) ?? null;
    if (items === null) { lines.push('Unavailable.'); continue; }
    if (!items.length) lines.push('None shown in the available parent view; this is not proof of no homework.');
    for (const item of items) lines.push(...itemLines(item, key === 'awaitingGrade' ? submittedSignals(item, observation) : []));
  }
  return lines;
}

// Plain text is canonical; escape it once for the HTML alternative. No remote
// images, tracking pixels, portal content HTML or bearer links enter the email.
export function buildReportEmail({ child, date, providers, cutoff }) {
  const observations = Object.fromEntries(providers.map(provider => [provider.provider, provider.observation]));
  const report = buildFamilyReport({ childId: child.id, ...observations, cutoff });
  const lines = [`School check-in for ${clean(child.display_name)} — ${date}`, `Prepared ${localTime(cutoff)} Seattle time.`,
    'A snapshot for choosing what to tackle next. Start with one thing that could make the biggest difference.', ''];
  for (const provider of providers) {
    lines.push(`${provider.provider === 'source' ? 'The Source' : 'Schoology'}: ${provider.current ? 'today’s check verified' : 'current check unavailable'}; last verified ${localTime(provider.observedAt)}.`);
    if (!provider.current) lines.push('Any records below are older context, not confirmation of today’s status.');
  }
  lines.push('', 'GRADES AND ACTIVE MISSING FLAGS — THE SOURCE');
  if (!report.source) lines.push('Unavailable. Missing work and grades are unknown.');
  else for (const course of report.source.courses) lines.push(...courseLines(course));
  lines.push('Partial credit does not establish completion, remaining effort, late-work eligibility or recoverable points. Confirm eligibility and grading impact before choosing priorities.',
    ...attendanceLines(report.source?.attendance), ...schoologyLines(report.schoology, observations.schoology), '',
    'Overdue is a status signal, not proof of non-submission. Check for a receipt or ask about paper/external-tool hand-ins before redoing work. A Schoology submission does not clear a Source missing flag.',
    'What is your one priority? What support would help?', '', 'Manage this child’s recipients in the private school app. These addresses receive this child’s report only.');
  const text = lines.join('\n');
  return { subject: `School check-in — ${clean(child.display_name).slice(0, 100)} — ${date}`, text,
    html: `<html><body><pre style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.55">${escape(text)}</pre></body></html>` };
}
