const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });

// Evaluate the local clock inside the existing minute trigger, including DST.
// Holidays are explicit exclusions; weekdays alone do not establish school days.
export function dailyCheckSlot(now, skippedDates = []) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (['Sat', 'Sun'].includes(parts.weekday) || Number(parts.hour) < 17 || skippedDates.includes(date)) return null;
  return date;
}

export function skippedCheckDates(value = '[]') {
  const dates = JSON.parse(value);
  if (!Array.isArray(dates) || dates.some(date => typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new Error('invalid_check_calendar');
  return dates;
}

export function localCheckDate(now) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Seattle midnight is 07:00 or 08:00 UTC. Check each boundary independently
// so a daylight-saving transition produces a 23- or 25-hour local day.
export function checkDayWindow(now) {
  const date = localCheckDate(now);
  const midnight = day => {
    const summer = Date.parse(`${day}T07:00:00Z`);
    const parts = Object.fromEntries(formatter.formatToParts(new Date(summer)).map(part => [part.type, part.value]));
    return parts.hour === '00' ? summer : summer + 3600000;
  };
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { start: new Date(midnight(date)).toISOString(), end: new Date(midnight(next)).toISOString() };
}
