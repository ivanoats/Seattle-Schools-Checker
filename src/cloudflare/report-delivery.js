import { digest, randomToken } from './connection-crypto.js';
import { dailyCheckSlot, skippedCheckDates, checkDayWindow } from './check-schedule.js';
import { normalizeReportRecipients } from '../core/report-recipients.js';
import { buildReportEmail } from '../core/report-email.js';

const rows = async statement => (await statement.all()).results;
const iso = now => new Date(now).toISOString();

export function reportDeliveryEnabled(env) {
  if (env.HOSTED_CHECKS_ENABLED !== 'true' || env.REPORT_EMAIL_ENABLED !== 'true' || (env.REPORT_EMAIL_TRANSPORT !== 'ses-pull' && typeof env.REPORT_EMAIL?.send !== 'function')
      || !/^\d{4}-\d{2}-\d{2}$/.test(env.REPORT_EMAIL_START_DATE ?? '')) return false;
  try {
    skippedCheckDates(JSON.stringify([env.REPORT_EMAIL_START_DATE]));
    return normalizeReportRecipients([env.REPORT_EMAIL_FROM]).length === 1;
  } catch { return false; }
}

export async function reportDeliveryStatus(env, familyId, childId) {
  if (!reportDeliveryEnabled(env)) return { status: 'not_enabled' };
  const latest = (await rows(env.DB.prepare(`SELECT state,check_date,updated_at FROM pilot_report_deliveries
    WHERE family_id=? AND child_id=? ORDER BY check_date DESC LIMIT 1`).bind(familyId, childId)))[0];
  return { status: 'enabled', startDate: env.REPORT_EMAIL_START_DATE, latest: latest ?? null };
}

// Read only observations tied to the CURRENT confirmed mapping, not a previous
// connection revision or another child with the same household-local ID.
async function providerState(env, child, provider, cutoff, window) {
  const mapping = (await rows(env.DB.prepare(`SELECT p.*,c.status FROM pilot_child_providers p JOIN pilot_connections c ON c.id=p.connection_id
    WHERE p.family_id=? AND p.child_id=? AND p.provider=? AND c.revision=p.revision AND c.status IN ('ready','attention')`)
    .bind(child.family_id, child.id, provider)))[0];
  if (!mapping) return { provider, current: false, waiting: false, observedAt: null, observation: null };
  const query = `SELECT pc.* FROM provider_checks pc JOIN pilot_check_jobs j ON j.id=pc.run_id
    WHERE pc.family_id=? AND pc.child_id=? AND pc.provider=? AND j.connection_id=? AND j.revision=? AND pc.received_at<=?
    AND EXISTS (SELECT 1 FROM json_each(j.children) k WHERE json_extract(k.value,'$.id')=pc.child_id
      AND json_extract(k.value,'$.providers.' || pc.provider)=?)`;
  const params = [child.family_id, child.id, provider, mapping.connection_id, mapping.revision, cutoff, mapping.mapping];
  const latest = (await rows(env.DB.prepare(`${query} ORDER BY pc.attempted_at DESC,pc.received_at DESC LIMIT 1`).bind(...params)))[0];
  const verified = (await rows(env.DB.prepare(`${query} AND pc.status='ok' AND pc.observed_at<=?
    ORDER BY pc.attempted_at DESC,pc.received_at DESC LIMIT 1`).bind(...params, cutoff)))[0];
  const today = latest && latest.attempted_at >= window.start && latest.attempted_at < window.end;
  const enabled = env[provider === 'source' ? 'SOURCE_CONNECTIONS_ENABLED' : 'SCHOOLOGY_CONNECTIONS_ENABLED'] === 'true';
  return { provider, current: Boolean(enabled && today && latest.status === 'ok' && mapping.status === 'ready'),
    waiting: Boolean(enabled && !today && mapping.status === 'ready'), observedAt: verified?.observed_at ?? null,
    observation: verified ? JSON.parse(verified.observation) : null };
}

export async function activeRecipients(env, child, revision = null) {
  const saved = (await rows(env.DB.prepare(`SELECT r.* FROM pilot_report_recipients r JOIN pilot_families f ON f.id=r.family_id
    WHERE r.family_id=? AND r.child_id=? AND f.revoked_at IS NULL AND (? IS NULL OR r.revision=?)`)
    .bind(child.family_id, child.id, revision, revision)))[0];
  if (!saved) return null;
  const recipients = normalizeReportRecipients(JSON.parse(saved.recipients));
  return recipients.length ? { recipients, revision: saved.revision } : null;
}

async function finish(env, child, date, state, now, reason = null, messageId = null) {
  await env.DB.prepare(`UPDATE pilot_report_deliveries SET state=?,updated_at=?,reason=?,message_id=?
    WHERE family_id=? AND child_id=? AND check_date=? AND state='sending'`)
    .bind(state, iso(now), reason, messageId, child.family_id, child.id, date).run();
}

export async function mappingSignature(env, child) {
  return JSON.stringify(await rows(env.DB.prepare(`SELECT p.provider,p.connection_id,p.revision,p.mapping,c.status FROM pilot_child_providers p
    JOIN pilot_connections c ON c.id=p.connection_id AND c.revision=p.revision
    WHERE p.family_id=? AND p.child_id=? ORDER BY p.provider`).bind(child.family_id, child.id)));
}

async function deliverChild(env, child, date, now, window, claimOnly) {
  const stored = (await rows(env.DB.prepare("SELECT * FROM pilot_report_deliveries WHERE family_id=? AND child_id=? AND check_date=?")
    .bind(child.family_id, child.id, date)))[0];
  const existing = stored?.state === 'waiting' ? null : stored;
  if (existing && (existing.state !== 'retry' || existing.next_attempt_at > iso(now))) return 'idle';
  const saved = await activeRecipients(env, child, existing?.recipient_revision);
  if (!saved) {
    if (existing) await env.DB.prepare(`UPDATE pilot_report_deliveries SET state='skipped',updated_at=?,reason='recipients_changed'
      WHERE family_id=? AND child_id=? AND check_date=? AND state='retry'`).bind(iso(now), child.family_id, child.id, date).run();
    return 'idle';
  }
  const mapping = await mappingSignature(env, child);
  const cutoff = existing?.cutoff ?? iso(now);
  const providers = await Promise.all(['source', 'schoology'].map(provider => providerState(env, child, provider, cutoff, window)));
  // Allow queued runners an hour from 5 p.m.; then send an explicit unavailable
  // snapshot. Seattle DST changes occur on Sundays, when no reports are sent.
  const deadline = Date.parse(window.start) + 18 * 3600000;
  if (!existing && providers.some(provider => provider.waiting) && now < deadline) {
    await env.DB.prepare(`INSERT INTO pilot_report_deliveries
      (family_id,child_id,check_date,recipient_revision,state,cutoff,updated_at,attempts)
      VALUES (?,?,?,?,'waiting',?,?,0) ON CONFLICT(family_id,child_id,check_date)
      DO UPDATE SET updated_at=excluded.updated_at WHERE pilot_report_deliveries.state='waiting'`)
      .bind(child.family_id, child.id, date, saved.revision, cutoff, iso(now)).run();
    return 'waiting';
  }
  const message = buildReportEmail({ child, date, providers, cutoff });
  const lease = randomToken();
  const leaseHash = await digest(lease);
  const expiresAt = iso(now + 120000);
  const claimed = await rows(env.DB.prepare(`INSERT INTO pilot_report_deliveries
    (family_id,child_id,check_date,recipient_revision,state,cutoff,updated_at,lease_hash,lease_expires_at,mapping_signature)
    SELECT r.family_id,r.child_id,?,r.revision,'sending',?,?,?,?,? FROM pilot_report_recipients r JOIN pilot_families f ON f.id=r.family_id
    WHERE r.family_id=? AND r.child_id=? AND r.revision=? AND f.revoked_at IS NULL
    ON CONFLICT(family_id,child_id,check_date) DO UPDATE SET state='sending',updated_at=excluded.updated_at,
      attempts=pilot_report_deliveries.attempts+1,next_attempt_at=NULL,cutoff=excluded.cutoff,recipient_revision=excluded.recipient_revision,
      lease_hash=excluded.lease_hash,lease_expires_at=excluded.lease_expires_at,mapping_signature=excluded.mapping_signature
      WHERE pilot_report_deliveries.state='waiting' OR (pilot_report_deliveries.state='retry'
        AND pilot_report_deliveries.recipient_revision=excluded.recipient_revision
        AND pilot_report_deliveries.next_attempt_at<=excluded.updated_at) RETURNING attempts`)
    .bind(date, cutoff, iso(now), leaseHash, expiresAt, mapping, child.family_id, child.id, saved.revision));
  if (!claimed.length) return 'idle';
  // Last possible ownership/list check before the irreversible transport call.
  const current = await activeRecipients(env, child, saved.revision);
  if (!current || mapping !== await mappingSignature(env, child)) {
    await finish(env, child, date, 'skipped', now, 'settings_changed'); return 'skipped';
  }
  if (claimOnly) return { kind: 'daily', familyId: child.family_id, childId: child.id, date, lease, expiresAt,
    message: { from: env.REPORT_EMAIL_FROM, bcc: current.recipients, ...message } };
  try {
    // The current structured Workers API explicitly permits BCC-only mail:
    // at least one of to/cc/bcc, without adding any unsaved recipient.
    const accepted = await env.REPORT_EMAIL.send({ from: { email: env.REPORT_EMAIL_FROM, name: 'School check-in' },
      bcc: current.recipients, ...message });
    if (typeof accepted?.messageId !== 'string' || !accepted.messageId) throw new Error('acceptance_unknown');
    await finish(env, child, date, 'sent', now, null, accepted.messageId);
    return 'sent';
  } catch (error) {
    // Only explicit pre-acceptance quota/rate rejections are safe to retry.
    // Timeouts, crashes and ambiguous responses may already have sent mail.
    const retryable = ['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED'].includes(error.code);
    if (retryable && claimed[0].attempts < 3) {
      await env.DB.prepare(`UPDATE pilot_report_deliveries SET state='retry',updated_at=?,next_attempt_at=?,reason='rate_limited'
        WHERE family_id=? AND child_id=? AND check_date=? AND state='sending'`)
        .bind(iso(now), iso(now + claimed[0].attempts * 300000), child.family_id, child.id, date).run();
      return 'retry';
    }
    const rejected = retryable || ['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_RECIPIENT_SUPPRESSED',
      'E_RECIPIENT_NOT_ALLOWED', 'E_VALIDATION_ERROR', 'E_FIELD_MISSING'].includes(error.code);
    await finish(env, child, date, rejected ? 'failed' : 'unknown', now, rejected ? 'delivery_rejected' : 'acceptance_unknown');
    return rejected ? 'failed' : 'unknown';
  }
}

export async function runReportDelivery(env, now = Date.now(), { claimOnly = false } = {}) {
  if (!reportDeliveryEnabled(env)) return { status: 'not_enabled' };
  const date = dailyCheckSlot(now, skippedCheckDates(env.HOSTED_CHECK_SKIP_DATES));
  if (!date || date < env.REPORT_EMAIL_START_DATE) return { status: 'idle' };
  // A crashed invocation is never resent: the email service has no idempotency
  // key. "unknown" is deliberately different from delivered or failed.
  await env.DB.prepare(`UPDATE pilot_report_deliveries SET state='unknown',reason='acceptance_unknown',updated_at=?
    WHERE state='sending' AND updated_at<=?`).bind(iso(now), iso(now - 300000)).run();
  await env.DB.prepare(`UPDATE pilot_report_deliveries SET state=CASE WHEN state='waiting' THEN 'skipped' ELSE 'failed' END,reason='delivery_window_elapsed',updated_at=?
    WHERE state IN ('retry','waiting') AND check_date<?`).bind(iso(now), date).run();
  if (env.REPORT_EMAIL_TRANSPORT === 'ses-pull' && !claimOnly) return { status: 'awaiting_ses_runner' };
  const children = await rows(env.DB.prepare(`SELECT k.* FROM pilot_children k JOIN pilot_families f ON f.id=k.family_id
    JOIN pilot_report_recipients r ON r.family_id=k.family_id AND r.child_id=k.id
    WHERE f.revoked_at IS NULL AND json_array_length(r.recipients)>0
      AND EXISTS (SELECT 1 FROM pilot_child_providers p WHERE p.family_id=k.family_id AND p.child_id=k.id)
      AND NOT EXISTS (SELECT 1 FROM pilot_report_deliveries d WHERE d.family_id=k.family_id AND d.child_id=k.id AND d.check_date=?
        AND (d.state NOT IN ('retry','waiting') OR (d.state='retry' AND d.next_attempt_at>?)))
    ORDER BY COALESCE((SELECT d.updated_at FROM pilot_report_deliveries d WHERE d.family_id=k.family_id
      AND d.child_id=k.id AND d.check_date=?),''),k.family_id,k.id LIMIT 10`).bind(date, iso(now), date));
  const outcomes = {};
  // Bound readiness queries AND sends. Persisted waiting timestamps rotate
  // unsent children fairly, rather than repeatedly scanning the same first ten.
  for (const child of children) {
    const state = await deliverChild(env, child, date, now, checkDayWindow(now), claimOnly);
    if (typeof state === 'object') return { status: 'claimed', job: state };
    outcomes[state] = (outcomes[state] ?? 0) + 1;
  }
  return { status: 'processed', outcomes };
}
