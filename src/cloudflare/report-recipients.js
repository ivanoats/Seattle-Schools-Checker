import { reportDeliveryStatus } from './report-delivery.js';
import { normalizeReportRecipients } from '../core/report-recipients.js';

const rows = async statement => (await statement.all()).results;
const revisionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function childExists(env, member, childId) {
  if (typeof childId !== 'string' || !childId || childId.length > 64) return false;
  return Boolean((await rows(env.DB.prepare(`SELECT k.id FROM pilot_children k JOIN pilot_families f ON f.id=k.family_id
    WHERE k.family_id=? AND k.id=? AND f.revoked_at IS NULL`).bind(member.family_id, childId))).length);
}

export async function readReportRecipients(env, member, childId) {
  if (typeof childId !== 'string' || !childId || childId.length > 64) return { statusCode: 404, body: { status: 'child_not_found' } };
  const saved = (await rows(env.DB.prepare(`SELECT k.id, r.recipients, r.revision FROM pilot_children k
    JOIN pilot_families f ON f.id=k.family_id LEFT JOIN pilot_report_recipients r ON r.family_id=k.family_id AND r.child_id=k.id
    WHERE k.family_id=? AND k.id=? AND f.revoked_at IS NULL`).bind(member.family_id, childId)))[0];
  if (!saved) return { statusCode: 404, body: { status: 'child_not_found' } };
  return { statusCode: 200, body: { status: 'ok', childId, recipients: saved.recipients ? JSON.parse(saved.recipients) : [],
    revision: saved.revision ?? null, delivery: await reportDeliveryStatus(env, member.family_id, childId) } };
}

export async function saveReportRecipients(env, member, input, now) {
  const { childId, revision } = input;
  if (!await childExists(env, member, childId)) return { statusCode: 404, body: { status: 'child_not_found' } };
  if (revision !== null && !revisionPattern.test(revision ?? '')) return { statusCode: 400, body: { status: 'invalid_recipient_revision' } };
  let recipients = null;
  try { recipients = normalizeReportRecipients(input.recipients); }
  catch (error) { return { statusCode: 400, body: { status: error.message } }; }
  const nextRevision = crypto.randomUUID();
  // One conditional write wins. Recheck family revocation in the statement,
  // and use the caller's revision to prevent a stale tab replacing a newer list.
  const saved = await rows(env.DB.prepare(`INSERT INTO pilot_report_recipients (family_id,child_id,recipients,revision,updated_at)
    SELECT k.family_id,k.id,?,?,? FROM pilot_children k JOIN pilot_families f ON f.id=k.family_id
    WHERE k.family_id=? AND k.id=? AND f.revoked_at IS NULL
      AND (? IS NULL OR EXISTS (SELECT 1 FROM pilot_report_recipients r WHERE r.family_id=k.family_id AND r.child_id=k.id))
    ON CONFLICT(family_id,child_id) DO UPDATE SET recipients=excluded.recipients,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE pilot_report_recipients.revision=? RETURNING revision`)
    .bind(JSON.stringify(recipients), nextRevision, new Date(now).toISOString(), member.family_id, childId, revision, revision));
  if (!saved.length) return { statusCode: 409, body: { status: 'recipient_settings_changed' } };
  return { statusCode: 200, body: { status: 'saved', childId, recipients, revision: nextRevision, delivery: await reportDeliveryStatus(env, member.family_id, childId) } };
}
