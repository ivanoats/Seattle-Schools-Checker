import { createHmac } from 'node:crypto';

// Decides whether the runner may sign in, so a broken setup cannot hammer
// the portal or lock the guardian account.
export const defaultIntervalMinutes = 360;
export const minimumIntervalMinutes = 60;
const signInFailures = new Set(['service_rejected_credentials', 'sign_in_needs_attention',
  'authentication_request_failed', 'blocked_credential_destination', 'unexpected_login_origin']);
const holdAfter = { service_rejected_credentials: 1 };
const defaultHoldAfter = 2;

// Identifies the stored credentials without keeping them in the state file.
export function credentialTag(key, { username, password }) {
  return createHmac('sha256', key).update(`${username}\0${password}`).digest('hex');
}

export function failureReason(error) {
  if (/^[a-z_]{1,64}$/.test(error?.status ?? '')) return error.status;
  if (error?.name === 'TimeoutError') return 'portal_timeout';
  return 'check_failed';
}

export function intervalMs(value) {
  const minutes = Number(value ?? defaultIntervalMinutes);
  return (Number.isFinite(minutes) ? Math.max(minutes, minimumIntervalMinutes) : defaultIntervalMinutes) * 60000;
}

// state: { lastAttemptAt, failures, hold: { reason, tag } }
export function decide(state, { now, interval, tag }) {
  if (state?.hold && state.hold.tag === tag) return { proceed: false, reason: 'held_after_sign_in_failure' };
  const last = Date.parse(state?.lastAttemptAt);
  if (Number.isFinite(last) && now - last < interval && now >= last) return { proceed: false, reason: 'too_soon' };
  return { proceed: true };
}

// A sign-in failure is counted. Enough of them in a row hold further
// attempts until the stored credentials change or an operator clears it.
export function nextState(state, { now, tag, runFailure }) {
  const next = { lastAttemptAt: new Date(now).toISOString(), failures: 0, hold: null };
  if (!signInFailures.has(runFailure)) return next;
  const sameCredentials = state?.failureTag === tag;
  next.failures = (sameCredentials ? state.failures ?? 0 : 0) + 1;
  next.failureTag = tag;
  if (next.failures >= (holdAfter[runFailure] ?? defaultHoldAfter)) next.hold = { reason: runFailure, tag };
  return next;
}
