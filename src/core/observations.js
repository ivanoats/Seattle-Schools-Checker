export function observeSchool({ provider, child, report, observedAt, assignmentRows }) {
  if (!['source', 'schoology'].includes(provider) || report.student !== child.displayName
      || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error('invalid_school_observation');
  }

  const base = { version: 1, childId: child.id, provider, observedAt };
  if (provider === 'source') {
    return {
      ...base,
      term: child.providers.source.term ?? null,
      courses: report.courses.map((course, index) => ({
        course: course.course,
        period: course.period,
        semester: course.semester,
        missing: assignmentRows?.[index]?.filter(row => row.missing && !row.excluded)
          ?? course.missing?.filter(item => !item.excluded) ?? null,
        rows: assignmentRows?.[index] ?? null,
      })),
      attendance: { absences: report.absences, tardies: report.tardies },
    };
  }

  return {
    ...base,
    overdue: report.overdue,
    upcoming: report.upcoming,
    recentlyCompleted: report.recentlyCompleted,
    events: report.events,
    overdueCoverage: report.overdueCoverage,
  };
}

function courseKey(course) {
  return JSON.stringify([course.course, course.period]);
}

function sameAssignment(left, right) {
  if (left.id && right.id) return left.id === right.id;
  return left.assignment === right.assignment && left.due === right.due;
}

function comparableSource(current, baseline) {
  return current?.provider === 'source' && baseline?.provider === 'source'
    && current.version === 1 && baseline.version === 1
    && current.childId === baseline.childId && Boolean(current.term)
    && current.term === baseline.term
    && Date.parse(current.observedAt) > Date.parse(baseline.observedAt);
}

export function compareMissing(current, baseline) {
  if (!comparableSource(current, baseline)) {
    return { status: 'baseline_unavailable', added: [], cleared: [], unavailable: [] };
  }

  const result = { status: 'verified', added: [], cleared: [], unavailable: [] };
  const priorCourses = new Map(baseline.courses.map(course => [courseKey(course), course]));
  for (const course of current.courses) {
    const key = courseKey(course);
    const prior = priorCourses.get(key);
    priorCourses.delete(key);
    const scope = { course: course.course, period: course.period };
    if (!prior?.missing || !course.missing) {
      result.unavailable.push(scope);
      continue;
    }

    for (const item of course.missing) {
      if (!prior.missing.some(previous => sameAssignment(previous, item))) {
        result.added.push({ ...scope, ...item });
      }
    }
    for (const item of prior.missing) {
      if (course.missing.some(row => sameAssignment(row, item))) continue;
      const candidates = course.rows?.filter(row => sameAssignment(row, item)) ?? [];
      if (candidates.length === 1 && candidates[0].missing === false) {
        result.cleared.push({ ...scope, ...item, ...candidates[0] });
      } else if (!result.unavailable.some(row => courseKey(row) === key)) {
        result.unavailable.push(scope);
      }
    }
  }
  for (const prior of priorCourses.values()) {
    result.unavailable.push({ course: prior.course, period: prior.period });
  }
  if (result.unavailable.length) result.status = 'partial';
  return result;
}

function publishedGrade(value) {
  const grade = value?.trim().replace(/\s+/g, ' ');
  const match = grade?.match(/^([A-F][+-]?)(?: (\d+(?:\.\d+)?)%?)?$/);
  if (!match || (match[2] !== undefined && Number(match[2]) === 0 && /^[A-D]/.test(match[1]))) return null;
  return grade;
}

export function compareSemesterGrades(current, baseline) {
  if (!comparableSource(current, baseline)) return null;
  const prior = new Map(baseline.courses.map(course => [courseKey(course), course]));
  return current.courses.flatMap(course => {
    const from = publishedGrade(prior.get(courseKey(course))?.semester);
    const to = publishedGrade(course.semester);
    return from && to && from !== to ? [{ course: course.course, period: course.period, from, to }] : [];
  });
}
