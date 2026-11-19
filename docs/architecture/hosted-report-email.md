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
so a slow discovery job does not starve delivery. The SES pull transport uses the AWS host's instance role, so no AWS access keys
are stored in Cloudflare. An authenticated AWS service claims one report over
HTTPS, re-authorizes immediately before sending, and records the SES message ID.
The transport token is the existing trusted Source-runner machine credential;
that host now also receives report content for confirmed children, including
Schoology. This expanded application boundary is explicit in deployment approval.
The IAM sending grant is independently restricted to the verified domain and
exact From address. The native binding remains only as an injectable legacy test
transport. Parent credentials never enter this module. Provider
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

Neither the SES SendEmail API nor the legacy binding exposes an idempotency key. Exactly-once delivery cannot be
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

1. Apply migrations 0007 and 0008, retaining `REPORT_EMAIL_ENABLED=false`.
2. Verify the SES domain's DKIM and custom MAIL FROM status in the sending region.
   Keep existing DNS/mail delivery. Check SES production access and account-level
   bounce/complaint suppression. Production access needs explicit operator consent
   and AWS approval; an approved request is not itself proof sending is enabled.
3. Configure `REPORT_EMAIL_TRANSPORT=ses-pull`, `REPORT_EMAIL_FROM`, and
   `REPORT_EMAIL_START_DATE` as private deployment settings. Cloudflare needs no
   SES keys or native Send Email binding. Preserve unrelated secret bindings.
4. On AWS, approve the restricted policy from `report-delivery-policy.yaml`, scoped
   to the existing runner role, verified domain and exact sender. Deploy the Node
   SES client and `report-delivery.service`/timer. The service reuses the existing
   origin and machine-token parameters. No parent or AWS credentials are written
   into source, logs or arguments. The SDK uses the instance role with one attempt;
   SDK automatic retries are disabled to avoid duplicate sends after ambiguous errors.
5. A test is an operator-created expiring `pilot_report_email_tests` row. It runs
   while regular delivery is off and contains no student records. Use a recipient
   allowed by the SES account's current state. Confirm the ledger's SES message ID
   and actual inbox receipt before enabling regular mail. Test rows expire and are
   not automatically resent. No public or family API can create a test or nominate
   arbitrary recipients.
6. Enable `REPORT_EMAIL_ENABLED=true` only after the test and required production
   approval. Confirm that each family intentionally saved its per-child lists.
   The minute cron maintains stale delivery state; the AWS timer claims one ready
   email every 15 seconds independently of the slower Source browser service.
7. Claim/authorize/complete routes require the scoped machine credential and exact
   HTTPS origin, refuse redirects, and use two-minute hashed leases. Completion
   checks the full family/child/day/lease identity. A stale completion or replay
   cannot update another child. Recipient revisions, family revocation and current
   portal mappings are checked immediately before transport. An email accepted
   after a settings change is recorded accurately, without restoring account access.
8. To pause, disable `REPORT_EMAIL_ENABLED`; the collector continues. Disable the
   AWS delivery timer to also pause test processing. Preserve the ledger on rollback.
   Expired or ambiguous sending claims become unknown rather than automatically resent.

Transport acceptance is not proof of inbox delivery. SES account-level suppression
handles hard bounces and complaints; application delivery/bounce webhooks are a
future enhancement. A non-ok sender result never claims success.

References: [SES SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html),
[SES domain authentication](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html).
