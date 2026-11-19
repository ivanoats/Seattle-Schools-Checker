import { assignmentIdentity, buildFamilyReport } from './family-report.js';

const localTime = value => value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'never verified';
const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ');
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

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
  else {
    for (const course of report.source.courses) {
      const missing = course.missing === null || (course.assignmentStatus && course.assignmentStatus !== 'available') ? null : course.missing;
      let grade = clean(course.semester) || 'grade unavailable';
      if (/^[A-D][+-]?\s+0(?:\.0+)?%?$/.test(grade)) grade = `${grade.split(/\s/)[0]} (displayed percentage inconsistent)`;
      lines.push(`${clean(course.course)} (period ${clean(course.period) || '?'}): ${grade}; ${missing === null ? 'missing work unknown' : `${missing.length} marked missing`}.`);
      for (const assignment of missing ?? []) lines.push(`  • ${clean(assignment.assignment)} — due ${clean(assignment.due) || 'date unavailable'}; recorded score ${clean(assignment.score) || 'unavailable'}.`);
    }
  }
  lines.push('Partial credit does not establish completion, remaining effort, late-work eligibility or recoverable points. Confirm eligibility and grading impact before choosing priorities.',
    '', 'ATTENDANCE — THE SOURCE');
  const attendance = report.source?.attendance;
  for (const kind of ['absences', 'tardies']) {
    const entries = attendance?.[kind];
    if (!Array.isArray(entries)) { lines.push(`${kind}: unavailable.`); continue; }
    lines.push(`${kind}: ${entries.length} class-period entries, not days.`);
    for (const entry of [...entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40)) {
      lines.push(`  • ${clean(entry.date)} — period ${clean(entry.period)}: ${clean(entry.code)}`);
    }
    if (entries.length > 40) lines.push('Showing the 40 most recent entries in this category.');
  }
  lines.push('ME: medical excused. EA: excused absent. UA/UL: explicitly unexcused. A/L: excusal status unspecified.', '', 'SCHOOLOGY');
  if (!report.schoology) lines.push('Unavailable. Turn-in status and deadlines are unknown.');
  else {
    if (!['expanded_visible_list', 'complete'].includes(report.schoology.overdueCoverage)) lines.push(`Overdue coverage: ${clean(report.schoology.overdueCoverage) || 'unknown'}. An incomplete list does not mean work is clear.`);
    const submitted = new Set(report.schoology.awaitingGrade?.map(assignmentIdentity).filter(Boolean));
    const sections = [['Schoology confirms submitted; awaiting grading', 'awaitingGrade'], ['Due later today (Seattle time)', 'dueToday'],
      ['Upcoming at last verified check', 'upcoming'], ['Overdue label; confirm turn-in', 'confirmTurnIn'],
      ['Conflicting deadline signals; verify the actual deadline', 'conflictingDeadlines'], ['Calendar events (not automatically assignment deadlines)', 'events']];
    for (const [title, key] of sections) {
      lines.push('', title);
      const items = report.schoology[key]?.filter(item => !['upcoming', 'conflictingDeadlines'].includes(key) || !submitted.has(assignmentIdentity(item))) ?? null;
      if (items === null) { lines.push('Unavailable.'); continue; }
      if (!items.length) lines.push('None shown in the available parent view; this is not proof of no homework.');
      for (const item of items) {
        lines.push(`  • ${clean(item.course)} — ${clean(item.assignment)}${item.dateLabel ? `; ${clean(item.dateLabel)}` : ''}${item.scheduledAt ? `; displayed event time ${localTime(item.scheduledAt)}` : ''}${item.alsoListedOverdue ? '; also listed overdue—submission is verified, do not redo without checking' : ''}`);
        for (const line of (item.description ?? '').split('\n').filter(line => /^\s*Due\b/i.test(line))) lines.push(`    ${clean(line)}`);
        if (item.submissionStatus) lines.push(`    ${clean(item.submissionStatus)}`);
        if (item.url && /^https:\/\/app\.schoology\.com\//.test(item.url)) lines.push(`    ${item.url}`);
      }
    }
  }
  lines.push('', 'Overdue is a status signal, not proof of non-submission. Check for a receipt or ask about paper/external-tool hand-ins before redoing work. A Schoology submission does not clear a Source missing flag.',
    'What is your one priority? What support would help?', '', 'Manage this child’s recipients in the private school app. These addresses receive this child’s report only.');
  const text = lines.join('\n');
  return { subject: `School check-in — ${clean(child.display_name).slice(0, 100)} — ${date}`, text,
    html: `<html><body><pre style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.55">${escape(text)}</pre></body></html>` };
}
