# Hosted report email

## Family experience

After each weekday check starting at 5 p.m. America/Los_Angeles, send one school
snapshot per confirmed child to that child's saved recipient list. Empty lists
receive nothing. There is no automatic parent copy and no shared household list.
Recipients receive the report via BCC and do not gain app access. Clearing the
list stops future sends; changing a sent day's list does not resend that report.
The recipients screen shows whether sending is configured and the latest attempt.
"Accepted" means the email provider accepted it, not that an inbox received it.

Messages contain Source semester grades, exact active missing assignment names,
due dates and recorded scores, attendance class-period entries, and Schoology
submitted/awaiting-grading, upcoming, overdue/confirm-turn-in and calendar signals.
Every provider carries its verification time. Older verified records are marked
as older context when the current check is unavailable. Unavailable tables stay
unknown. A submitted item that also appears overdue is shown as progress, without
repeating it in a redo/next-actions list. No glucose data is included.

The schedule follows the existing weekday collector and its explicit closure-date
list; it is not a complete school calendar. Five is the beginning of the check
window, not a guaranteed inbox time. Initial onboarding alone does not send an
email before the weekday window. An initial same-day check can supply the report
if the collector suppresses a duplicate sign-in; the actual verification time
remains visible. If a connected provider has no finished attempt today, delivery
waits until both providers have an attempt, or 6 p.m., then labels missing checks
unavailable. A disconnected/unconnected provider is immediately unavailable.

## Implementation and boundaries

`src/core/report-email.js` renders the portable family report as plain text and
escaped HTML, without remote images, tracking or portal HTML. Header fields are
single-line and Schoology links use the official HTTPS origin. Rendering does not
infer submission or completion from missing flags, scores or overdue labels.
Attendance counts are periods, with excused/unspecified/unexcused codes explained.
Long attendance categories show the latest 40 entries and say they are truncated.

`src/cloudflare/report-delivery.js` runs before browser work on each minute tick,
so a slow discovery job does not starve delivery. It uses Cloudflare's structured
Email Sending binding. Parent credentials never enter this module. Provider
observations are selected through the current confirmed connection revision AND
child mapping, scoped by family and child; older revoked/replaced mappings cannot
supply records. Membership revocation and recipient revision are checked again
immediately before transport, as is the connection/mapping signature. An email
already accepted by the service cannot be recalled by a later settings change.

Migration 0007 adds a unique `(family_id,child_id,check_date)` ledger. Atomic claims
prevent overlapping scheduler ticks sending duplicates. The ledger stores only
recipient revision, cutoff, attempt count, state, provider message ID and generic
reason; it duplicates neither recipient addresses nor school records/email bodies.
Bodies are regenerated from observations bounded by the saved cutoff on a safe
retry. Ten children per tick bound readiness queries and sender work, reserving capacity
for collection. Waiting timestamps persist and rotate the queue fairly. Terminal
rows are skipped in SQL; waiting households do not block other ready households.

Cloudflare's binding exposes no idempotency key. Exactly-once delivery cannot be
claimed across the database/transport boundary. Only explicit quota/rate rejection
codes, which did not accept mail, retry (at five and ten minutes; three attempts
maximum, same local date). A crash, timeout, ambiguous reply or expired sending
claim becomes `unknown`, with no automatic resend. Permanent rejection is `failed`.
A changed recipient revision cancels pending retries. Old retries expire instead
of sending yesterday's report. `sent` records acceptance and is never retried.
The app distinguishes these outcomes; it does not claim delivery from a cron tick.

This is an additive hosted feature. Local Keychain checks, local email automation,
and PDF creation are unchanged. Operators must avoid duplicate local/hosted sends
to the same recipients when migrating a household. No test sends are automatic.

## Configuration, rollout and rollback

1. Apply migration 0007. Keep `REPORT_EMAIL_ENABLED=false` while validating.
2. Onboard the chosen sender domain in Cloudflare Email Sending (Workers Paid),
   verifying SPF/DKIM and reviewing DMARC without disrupting existing mail. Disable
   email body preview for school-record privacy where supported. Keep suppression
   protections; do not silently drop recipients. Domain ownership and available
   sending quota must be verified independently of application tests.
3. Configure `REPORT_EMAIL` with `bindings.sendEmail()`, `REPORT_EMAIL_FROM` with
   the verified sender, and `REPORT_EMAIL_START_DATE` with the first local date to
   send. These deployment values contain no repository personal identity. Leave
   unrelated remote secret bindings intact. Do not use a Gmail address as a From
   identity for Cloudflare Email Sending; use an owned, verified domain.
4. Deploy the reviewed Worker and set `REPORT_EMAIL_ENABLED=true` only after the
   sender is ready. Set a future local date to prevent an activation-night backfill.
   Ensure families have intentionally saved their own lists. Confirm a real
   provider message ID and inbox receipt during an authorized acceptance test;
   unit/UI tests use only a mocked transport, not synthetic external addresses.
5. Monitor ledger states and Cloudflare Email activity/bounces without logging
   school bodies, addresses or credentials. The initial binding response establishes
   acceptance only; bounce/delivery webhooks are a future enhancement.
6. To pause, disable `REPORT_EMAIL_ENABLED`. The collector continues. Preserve the
   ledger on rollback to avoid a duplicate day; older versions ignore the table.

References: [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/).
