import { CheckError } from './auth.js';

export function summarize(points, start, end, low = 70, high = 180) {
  const data = points.filter(p => p.t >= start && p.t < end).sort((a, b) => a.t - b.t);
  const events = [];
  let active = null;
  for (const p of data) {
    const type = p.v < low ? 'low' : p.v > high ? 'high' : null;
    if (!type) { active = null; continue; }
    const previous = active;
    if (previous?.type === type && p.t - previous.end < 7 * 60000) {
      previous.end = p.t; previous.min = Math.min(previous.min, p.v); previous.max = Math.max(previous.max, p.v);
    } else { active = { type, start: p.t, end: p.t, min: p.v, max: p.v }; events.push(active); }
  }
  return { readings: data.length, expectedReadings: Math.round((end - start) / 300000),
    coveragePct: Math.min(100, Math.round(data.length / ((end - start) / 300000) * 100)),
    min: data.length ? Math.min(...data.map(p => p.v)) : null,
    max: data.length ? Math.max(...data.map(p => p.v)) : null,
    events: events.map(e => ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() })) };
}
export function seattleTime(date, hhmm) {
  // Find the offset at local noon for this day; evening/night windows are constructed separately.
  const noon = new Date(date + 'T20:00:00Z');
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .formatToParts(noon).find(p => p.type === 'timeZoneName').value;
  const hours = Number(offset.replace('GMT', ''));
  return Date.parse(`${date}T${hhmm}:00Z`) - hours * 3600000;
}
export function windowsFor(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new CheckError('invalid_dates');
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const previous = new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const w = (d, a, b) => ({ start: seattleTime(d, a), end: seattleTime(d, b) });
  const result = { evening: w(previous, '18:00', '23:00'), overnight: { start: seattleTime(previous, '23:00'), end: seattleTime(date, '08:50') },
    school: w(date, '08:50', weekday === 3 ? '14:25' : '15:40') };
  const table = weekday === 3 ? { P1: ['08:50','09:25'], P2:['09:30','10:05'], MNT:['10:10','11:10'], P3:['11:15','11:50'], P4:['12:30','13:05'], P5:['13:10','13:45'], P6:['13:50','14:25'] }
    : [1,5].includes(weekday) ? { P1:['08:50','09:45'], P2:['09:50','10:45'], P3:['10:50','11:40'], P4_A:['12:20','13:10'], P4_B:['11:45','12:35'], MNT:['13:15','13:50'], P5:['13:55','14:45'], P6:['14:50','15:40'] }
    : { P1:['08:50','09:45'], P2:['09:50','10:45'], P3:['10:50','11:50'], P4_A:['12:30','13:30'], P4_B:['11:55','12:55'], P5_core:['13:35','14:25'], P5_uncertain:['14:25','14:35'], P6:['14:40','15:40'] };
  if (date === '2026-10-08') {
    for (const [k,a,b] of [['P1','12:45','13:10'],['P2','13:15','13:40'],['P3','13:45','14:10'],['P4','14:15','14:40'],['P5','14:45','15:10'],['P6','15:15','15:40']]) result[k] = w(date,a,b);
  } else for (const [key, times] of Object.entries(table)) result[key] = w(date, ...times);
  return result;
}

export async function readGlucose(page, dates) {
  if (!dates.length) throw new CheckError('dates_required');
  // The configured settings are read afresh on every comparison.
  await page.goto('https://app.sugarmate.io/settings/ranges');
  const low = Number(await page.locator('#range-normal-bottom-number').inputValue());
  const high = Number(await page.locator('#range-normal-top-number').inputValue());
  if (!(low > 0 && high > low)) throw new CheckError('glucose_ranges_unavailable');
  await page.goto('https://app.sugarmate.io/home');
  await page.locator('#graph button#glucose-activity-icon').first().waitFor();
  const read = () => page.locator('#graph').evaluate(el => ({
    cells: Array.from(el.querySelectorAll('[class*="Cell_container"]')).map(c => ({
      right: parseFloat(c.style.right), width: parseFloat(c.style.width),
      labels: Array.from(c.querySelectorAll('[class*="TimeMarker_container"]')).map(m => ({ left: parseFloat(m.style.left), text: m.innerText })),
      points: Array.from(c.querySelectorAll('button#glucose-activity-icon')).map(p => ({ left: parseFloat(p.parentElement.style.left) + parseFloat(p.style.left), v: parseFloat(p.style.bottom) * 4 })),
    })), max: Number((document.querySelector('#y-axis-button')?.innerText || '').match(/0\s+(\d+)/)?.[1]),
  }));
  const initial = await read();
  if (initial.max !== 400 || initial.cells.length < 2) throw new CheckError('glucose_chart_changed');
  // Anchor the newest full cell using the actual current hour and graph hour label.
  const cell = initial.cells.find(c => c.width === 1920 && c.labels.length === 12);
  if (!cell || cell.labels[1].left - cell.labels[0].left !== 160) throw new CheckError('glucose_chart_changed');
  const label = cell.labels[0].text.replace(/\u00ad/g, '').trim().match(/^(\d+):00\s*(AM|PM)$/);
  if (!label) throw new CheckError('glucose_chart_changed');
  const targetHour = Number(label[1]) % 12 + (label[2] === 'PM' ? 12 : 0);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const part = k => parts.find(p => p.type === k).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  let anchorTime = seattleTime(today, String(targetHour).padStart(2,'0') + ':00');
  if (anchorTime > now.getTime()) anchorTime -= 86400000;
  const anchor = -cell.right;
  const points = new Map();
  function collect(chart) {
    for (const c of chart.cells) {
      if (c.width !== 1920) continue;
      for (const p of c.points) {
        const t = anchorTime + (-c.right + p.left - anchor) * 3600000 / 160;
        points.set(Math.floor(t / 60000), { t, v: Math.round(p.v) });
      }
    }
  }
  collect(initial);
  const windows = dates.map(d => ({ date:d, windows:windowsFor(d) }));
  const earliest = Math.min(...windows.map(d => d.windows.evening.start));
  if (now.getTime() - earliest > 90 * 86400000) throw new CheckError('history_out_of_range');
  for (let i = 0; Math.min(...Array.from(points.values()).map(p => p.t)) > earliest && i < 150; i++) {
    // Scroll the observed native horizontal list, never change application data.
    await page.locator('#graph').hover();
    await page.mouse.wheel(-3840, 0);
    await page.waitForTimeout(100);
    collect(await read());
  }
  const data = Array.from(points.values());
  return { timezone:'America/Los_Angeles', thresholds:{ low, high }, approximate:true,
    limitations:['Graph-derived timestamps; values at 400 may be clipped.', 'A/B lunch unknown; Tuesday/Thursday P5 ending uncertain.', 'Standard period windows require date-specific schedule verification.'],
    days:windows.map(({date,windows}) => ({ date, windows:Object.fromEntries(Object.entries(windows).map(([name,w]) => [name, { start:new Date(w.start).toISOString(), end:new Date(w.end).toISOString(), ...summarize(data,w.start,w.end,low,high) }])) })) };
}
