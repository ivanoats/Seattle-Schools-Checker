# Per-child report recipients

## Parent experience

Select a confirmed child, then use **Report recipients** below School connections.
Paste up to ten address-only emails, one per line or separated by commas. The
editor also accepts semicolons. Save the list, edit it later, or clear it and save
to remove everyone. Each sibling has a separate list. Parent, child and partner
addresses are entered by the parent; no real addresses are seeded into code.

Hosted delivery uses this saved list after the weekday check. See
[hosted report email](hosted-report-email.md) for configuration, delivery states,
retry limits and rollout. Until a verified sender and delivery flag are configured,
the app explicitly says **Email delivery is not enabled yet**. Recipients do not
gain account access. Local email/PDF automation remains separate.

## Data and access

Migration 0006 adds `pilot_report_recipients`, keyed by family and child with a
foreign key to confirmed children. Addresses are private application data in D1,
not repository configuration, URLs or logs. Clearing a list removes its stored
addresses while retaining only an empty list and revision metadata.

`GET /api/pilot/report-recipients?childId=…` reads the current list. `POST` replaces
it using `{ childId, recipients, revision }`. Both run behind the existing verified
Access session and active family membership. Family identity comes from the
server, never the body or query. The read joins the child, active family and
settings in one statement. Writes recheck active-family and child ownership.
Existing same-origin/CSRF and request-size checks apply.

The server trims addresses, accepts common ASCII mailbox formats including plus
tags, normalizes the domain, deduplicates case-insensitively and rejects malformed
addresses, display-name/header syntax, more than ten inputs, and oversized fields.
Validation checks syntax; it does not prove that an address exists or its owner
wants to receive school reports. Saving does not send a validation message or an immediate report.

Each successful write creates a new opaque revision. Saving with a stale revision
returns a conflict and preserves the newer list. The UI leaves the draft editable
for copying, disables another save, and offers an explicit reload. Child switches
and late save responses cannot replace another child's editor. Refreshing the
school report preserves unsaved recipient edits for the current child. Recipient
loading runs independently, so a stalled settings request cannot hide the school
report.

## Validation and rollout

Backend tests cover address syntax, duplicate normalization, family and sibling
isolation, overlapping child IDs, stale/concurrent writes, removal, CSRF, forged
identity and revocation. `npm run test:recipients-ui` uses synthetic authenticated
requests against SQLite and real Chrome to verify phone/desktop layouts, pasted
lists, persistence, clearing, conflicts and a delayed save during a child switch.
No school portal or email provider is contacted by the tests.

Apply migration 0006 before deploying the new Worker and UI. An unavailable
settings endpoint leaves editing disabled until a successful reload. Existing
portal collectors and local reports keep their current behavior. The UI shows disabled delivery until the hosted sender is configured and enabled.
