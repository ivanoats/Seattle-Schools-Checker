import { compareMissing, compareSemesterGrades } from './observations.js';

function localDate(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const part = type => parts.find(entry => entry.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function assignmentIdentity(item) {
  if (!item.course || !item.url) return null;
  const url = new URL(item.url);
  const destination = url.searchParams.get('url') ?? url.pathname;
  const id = destination.match(/(?:^|\/)assignments?\/(\d+)(?:\/|$)/)?.[1];
  return JSON.stringify([item.course, id ? `assignment:${id}` : url.href]);
}

export function buildFamilyReport({ childId, source, schoology, baseline, cutoff, timezone = 'America/Los_Angeles' }) {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error('invalid_report_cutoff');
  for (const [provider, observation] of Object.entries({ source, schoology })) {
    if (observation && (observation.version !== 1 || observation.childId !== childId
        || observation.provider !== provider || !(Date.parse(observation.observedAt) <= Date.parse(cutoff)))) {
      throw new Error('invalid_report_observation');
    }
  }

  const upcoming = schoology?.upcoming ?? null;
  const overdue = schoology?.overdue ?? null;
  const completed = schoology?.recentlyCompleted ?? null;
  const awaitingGrade = completed?.filter(item => item.submissionStatus ===
    'This material has been submitted but not yet graded') ?? null;
  const submitted = new Set(awaitingGrade?.map(assignmentIdentity).filter(Boolean));
  const overdueKeys = new Set(overdue?.map(assignmentIdentity).filter(Boolean));

  const dueLaterToday = item => {
    // Calendar metadata alone does not establish an assignment deadline.
    if (!/\bDue\b/i.test(item.dateLabel ?? '') && !/(?:^|\n)Due\s/i.test(item.description ?? '')) return false;
    return Date.parse(item.scheduledAt) > Date.parse(cutoff)
      && localDate(item.scheduledAt, timezone) === localDate(cutoff, timezone);
  };
  const upcomingKeys = new Set(upcoming?.filter(item => Date.parse(item.scheduledAt) > Date.parse(cutoff))
    .map(assignmentIdentity).filter(Boolean));
  const conflictingDeadlines = overdue?.filter(item => Date.parse(item.scheduledAt) > Date.parse(cutoff)
    || upcomingKeys.has(assignmentIdentity(item))) ?? null;
  const dueToday = [];
  const seenDue = new Set();
  for (const item of [...(upcoming ?? []), ...(conflictingDeadlines ?? [])]) {
    const identity = assignmentIdentity(item);
    if (!dueLaterToday(item) || submitted.has(identity) || (identity && seenDue.has(identity))) continue;
    if (identity) seenDue.add(identity);
    dueToday.push(item);
  }
  return {
    version: 1,
    childId,
    cutoff,
    timezone,
    source: source ? {
      observedAt: source.observedAt,
      term: source.term,
      courses: source.courses.map(({ rows, ...course }) => course),
      attendance: source.attendance,
      missingChanges: compareMissing(source, baseline),
      semesterGradeChanges: compareSemesterGrades(source, baseline),
    } : null,
    schoology: schoology ? {
      observedAt: schoology.observedAt,
      overdueCoverage: schoology.overdueCoverage,
      upcoming,
      dueToday: upcoming === null && dueToday.length === 0 ? null : dueToday,
      awaitingGrade: awaitingGrade?.map(item => ({
        ...item, alsoListedOverdue: overdueKeys.has(assignmentIdentity(item)),
      })) ?? null,
      confirmTurnIn: overdue?.filter(item => {
        const identity = assignmentIdentity(item);
        return !submitted.has(identity) && !conflictingDeadlines.includes(item)
          && !upcomingKeys.has(identity);
      }) ?? null,
      conflictingDeadlines,
      events: schoology.events,
    } : null,
  };
}
