import { sites } from './auth.js';

const sameScoresPage = value => {
  try { const url = new URL(value); return url.origin === sites.source.origin && url.pathname === '/guardian/scores.html'; }
  catch { return false; }
};
const ids = (values, limit) => Array.isArray(values) && values.length > 0 && values.length <= limit
  && values.every(value => ['string', 'number'].includes(typeof value) && /^\d{1,12}$/.test(String(value)));
const date = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));

function lookupRequest(page, request, url) {
  return request.method() === 'POST' && !request.isNavigationRequest() && request.resourceType() === 'xhr'
    && request.frame() === page.mainFrame() && url.origin === 'https://ps.seattleschools.org'
    && url.pathname === '/ws/xte/assignment/lookup' && !url.username && !url.password && !url.hash;
}

// PowerSchool's rendered guardian score page uses this POST to READ its grid.
// Continue the browser's request; never construct or replay the internal API.
// No other method, endpoint, frame, credential payload or record mutation is allowed.
export function sourceAssignmentLookup(page, request) {
  try {
    const url = new URL(request.url());
    if (!lookupRequest(page, request, url)) return false;
    if (!sameScoresPage(page.url()) || !sameScoresPage(request.headers().referer)
      || !/^application\/json(?:;|$)/i.test(request.headers()['content-type'] ?? '')) return false;
    const cache = [...url.searchParams];
    if (cache.length > 1 || cache.some(([key, value]) => key !== '_' || !/^\d{1,20}$/.test(value))) return false;
    if (!request.postData() || request.postData().length > 4096) return false;
    const body = request.postDataJSON();
    if (!body || Array.isArray(body) || Object.keys(body).sort((left, right) => left.localeCompare(right)).join(',') !== 'end_date,section_ids,start_date,student_ids') return false;
    return ids(body.section_ids, 100) && ids(body.student_ids, 1) && date(body.start_date) && date(body.end_date)
      && Date.parse(body.start_date) <= Date.parse(body.end_date);
  } catch { return false; }
}
