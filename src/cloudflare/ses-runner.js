import { authorized } from './ingest.js';
import { digest, randomToken } from './connection-crypto.js';
import { runReportDelivery, activeRecipients, mappingSignature, reportDeliveryEnabled } from './report-delivery.js';
import { normalizeReportRecipients } from '../core/report-recipients.js';

const rows = async statement => (await statement.all()).results;
const iso = now => new Date(now).toISOString();
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

function configured(env) {
  if (env.REPORT_EMAIL_TRANSPORT !== 'ses-pull') return false;
  try { return normalizeReportRecipients([env.REPORT_EMAIL_FROM]).length === 1; } catch { return false; }
}

async function claimTest(env, now) {
  await env.DB.prepare("UPDATE pilot_report_email_tests SET state='unknown' WHERE state='sending' AND lease_expires_at<=?").bind(iso(now)).run();
  const lease = randomToken(); const expiresAt = iso(now + 120000);
  const result = await rows(env.DB.prepare(`UPDATE pilot_report_email_tests SET state='sending',lease_hash=?,lease_expires_at=?
    WHERE id=(SELECT id FROM pilot_report_email_tests WHERE state='queued' AND expires_at>? ORDER BY created_at,id LIMIT 1)
    AND state='queued' RETURNING id,recipient`).bind(await digest(lease), expiresAt, expiresAt));
  if (!result.length) return null;
  const test = result[0];
  const recipients = normalizeReportRecipients([test.recipient]);
  return { kind: 'test', id: test.id, lease, expiresAt, message: { from: env.REPORT_EMAIL_FROM, bcc: recipients,
    subject: `School check-in delivery test ${test.id}`, text: 'This is a delivery test from the hosted school report sender. It contains no student records.',
    html: '<p>This is a delivery test from the hosted school report sender. It contains no student records.</p>' } };
}

async function liveJob(env, input, now) {
  if (!/^[a-f0-9]{64}$/.test(input?.lease ?? '')) return null;
  const hash = await digest(input.lease);
  if (input.kind === 'test' && /^[a-f0-9-]{36}$/.test(input.id ?? '')) {
    const test = (await rows(env.DB.prepare(`SELECT * FROM pilot_report_email_tests WHERE id=? AND lease_hash=? AND state='sending'
      AND lease_expires_at>? AND expires_at>?`).bind(input.id, hash, iso(now), iso(now))))[0];
    return test ? { kind: 'test', key: [test.id, hash], allowed: true } : null;
  }
  if (input.kind !== 'daily' || ![input.familyId,input.childId,input.date].every(value => typeof value === 'string' && value.length < 65)) return null;
  const saved = (await rows(env.DB.prepare(`SELECT * FROM pilot_report_deliveries WHERE family_id=? AND child_id=? AND check_date=?
    AND lease_hash=? AND state='sending' AND lease_expires_at>?`)
    .bind(input.familyId,input.childId,input.date,hash,iso(now))))[0];
  if (!saved) return null;
  const child = { family_id: saved.family_id, id: saved.child_id };
  const allowed = reportDeliveryEnabled(env) && Boolean(await activeRecipients(env, child, saved.recipient_revision))
    && saved.mapping_signature === await mappingSignature(env, child);
  return { kind: 'daily', key: [saved.family_id,saved.child_id,saved.check_date,hash], allowed, attempts: saved.attempts };
}

function updateJob(env, job, state, messageId, now) {
  if (job.kind === 'test') {
    if (state === 'retry') state = 'failed';
    return env.DB.prepare("UPDATE pilot_report_email_tests SET state=?,message_id=? WHERE id=? AND lease_hash=? AND state='sending'")
      .bind(state,messageId,...job.key).run();
  }
  if (state === 'retry' && job.attempts >= 3) state = 'failed';
  return env.DB.prepare(`UPDATE pilot_report_deliveries SET state=?,message_id=?,updated_at=?,reason=?,next_attempt_at=?
    WHERE family_id=? AND child_id=? AND check_date=? AND lease_hash=? AND state='sending'`)
    .bind(state,messageId,iso(now),state==='sent'?null:`ses_delivery_${state}`,state==='retry'?iso(now+job.attempts*300000):null,...job.key).run();
}

export async function handleSesRunner(request, env, action, readBody, clock = Date.now) {
  const url = new URL(request.url);
  if (!configured(env) || url.protocol !== 'https:' || url.origin !== env.APP_ORIGIN
      || !await authorized(request,env.SOURCE_DISCOVERY_TOKEN)) return reply(404,{status:'not_found'});
  if (request.method !== 'POST') return reply(405,{status:'method_not_allowed'});
  try {
    if (action === 'claim') {
      const test = await claimTest(env,clock());
      if (test) return reply(200,{status:'claimed',job:test});
      const result = await runReportDelivery(env,clock(),{claimOnly:true});
      return reply(200,result.status==='claimed'?result:{status:'idle'});
    }
    const input = await readBody(request); const now = clock();
    return await processJobAction(env,action,input,now);
  } catch { return reply(503,{status:'email_runner_unavailable'}); }
}

async function processJobAction(env,action,input,now) {
  const job = await liveJob(env,input,now);
  if (!job) return reply(409,{status:'stale_job'});
  if (action === 'authorize') {
    if (!job.allowed) await updateJob(env,job,'skipped',null,now);
    return reply(job.allowed?200:409,{status:job.allowed?'authorized':'settings_changed'});
  }
  if (!['sent','failed','unknown','retry'].includes(input.state)
    || (input.state==='sent' && !/^[a-zA-Z0-9-]{1,200}$/.test(input.messageId ?? ''))) return reply(400,{status:'invalid_result'});
  // A send already accepted cannot be recalled. Record its outcome even if
  // settings changed after the last authorization, without reviving access.
  const write = await updateJob(env,job,input.state,input.state==='sent'?input.messageId:null,now);
  const changed = (write.meta?.changes ?? write.changes) === 1;
  return reply(changed?200:409,{status:changed?'recorded':'stale_job'});
}
