const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= 10000;
const optionalText = value => value === undefined || value === null || text(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const list = (value, validate) => Array.isArray(value) && value.length <= 10000 && value.every(validate);
const nullableList = (value, validate) => value === null || list(value, validate);
function assignment(value) {
  return record(value) && text(value.assignment) && value.assignment.length > 0 && optionalText(value.id)
    && optionalText(value.due) && optionalText(value.score)
    && (value.missing === undefined || typeof value.missing === 'boolean')
    && (value.excluded === undefined || typeof value.excluded === 'boolean');
}
function course(value) {
  return record(value) && text(value.course) && value.course.length > 0 && optionalText(value.period)
    && optionalText(value.semester) && optionalText(value.assignmentStatus)
    && nullableList(value.missing, assignment) && nullableList(value.rows, assignment);
}
function attendance(value) {
  return record(value) && text(value.period) && timestamp(value.date) && /^[A-Z]{1,10}$/.test(value.code ?? '');
}
function schoologyItem(value) {
  if (!record(value) || !text(value.assignment) || !value.assignment || !text(value.url)) return false;
  try {
    const url = new URL(value.url);
    if (url.origin !== 'https://app.schoology.com' || url.username || url.password) return false;
  } catch { return false; }
  return optionalText(value.course) && optionalText(value.description) && optionalText(value.submissionStatus)
    && optionalText(value.dateLabel) && (value.scheduledAt === null || timestamp(value.scheduledAt));
}

export function validSchoolObservation(observation, childId, provider, earliest, now) {
  if (!record(observation) || observation.version !== 1 || observation.provider !== provider || observation.childId !== childId
    || !timestamp(observation.observedAt)) return false;
  const observed = Date.parse(observation.observedAt);
  if (observed < earliest || observed > now) return false;
  if (provider === 'source') return optionalText(observation.term) && list(observation.courses, course) && observation.courses.length > 0
    && record(observation.attendance) && list(observation.attendance.absences, attendance) && list(observation.attendance.tardies, attendance);
  return ['overdue', 'upcoming', 'events', 'recentlyCompleted'].every(field => nullableList(observation[field], schoologyItem));
}
