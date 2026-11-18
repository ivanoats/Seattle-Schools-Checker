# Invite-only web pilot

## Implemented locally

This branch adds the first parent-facing slice, not a self-service release.
No cloud resources have been changed and no invitations have been sent.

- `/app` provides a responsive child picker, saved provider check times,
  semester grades, Source missing work, attendance, and Schoology evidence
  classified by the portable report model.
- Cloudflare Access JWT verification checks the signature, configured issuer,
  audience and expiry against rotating public keys. An email header alone
  cannot grant access. Application membership is checked on every request.
- Email-bound invitations expire after seven days and are stored as hashes.
  Acceptance is explicit and transactional. Each invitation creates a family.
  Replaying a link cannot grant a second identity access to that family.
- Child lists, saved selection and records are scoped to server-derived family
  membership, including when two families have overlapping child IDs.
- Failed attempts preserve previous verified observations, displayed with the
  original verification time and a failed-latest-check notice.
- School connections are explicitly unavailable. No passwords are collected
  and no Connect button claims that discovery works.
- Existing runner ingestion, local Keychain, checks and report workflows are
  unchanged. The existing runner is not enrolled in the new membership tables.

## Live inspection on November 18, 2026

- The deployed Cloudflare Worker has one active version from November 12,
  with D1 and the four existing single-family secrets bound. Its `/app`
  route returns HTTP 404. The dashboard in this branch is not live.
- A direct `sqlite_master` read confirms the `provider_checks` table exists;
  an aggregate query found no recorded provider checks. The new family tables
  are absent. D1 list metadata incorrectly reported zero tables, so the direct
  schema query is the stronger evidence.
- The Access API reports `access.api.error.not_enabled`. Parent sign-in
  must be enabled/configured before invitations can work.
- The Oregon EC2 probe instance is stopped and has no IAM instance profile.
  There are no Oregon Scheduler schedules. The two historical `source-runner`
  CloudFormation stacks are `DELETE_COMPLETE`; there is no active stack with
  that name. No instance was started and no infrastructure was changed.

Evidence came from Worker deployment/version records, D1 schema and aggregate
queries, the Access applications API, EC2 DescribeInstances, Scheduler
ListSchedules, and CloudFormation ListStacks/DescribeStacks. No credential
values or raw student observations were retrieved.

## Required before another household can onboard

| Work | Exit evidence |
| --- | --- |
| Verify live AWS/Cloudflare state | Authenticated deployment status and approved deployed smoke test |
| Deploy Access and invitation flow | Parent opens an invitation and receives an email code from a phone |
| Family-scoped provider accounts | Encrypted credentials, revocation/deletion, isolated sessions and per-account sign-in limits |
| Source discovery on AWS | Guardian signs in; only their linked children are discovered and full identities verified |
| Schoology on Browser Run | Worker binding, isolated browser contexts, child discovery/selection, reconnect and challenge handling |
| Trusted child discovery ingestion | Persist verified provider mappings; never trust arbitrary mappings from the browser |
| Multi-family collection | Replace single-family ingest configuration with family/account-scoped job claims and runner authorization |
| Hosted schedule and reports | School-calendar-aware jobs, comparisons and private PDFs independent of local Codex |
| Second household acceptance | Parent connects both services, selects her son, sees verified records and revokes access without help |

ADR 0006's live provider tests were for one parent account. They establish
host compatibility, not readiness for a second family.

## Operator setup for this slice

Do these steps only after deployment approval. Parents do not execute them.

1. Install dependencies at the repository root and in `worker/`. The root
   package supplies the JWT verifier to both the tests and Worker build.
2. Apply migration `0002_pilot_families.sql` after migration 0001.
3. Set `APP_ORIGIN` to the exact HTTPS app origin, `ACCESS_TEAM_DOMAIN` to
   the team hostname ending in `.cloudflareaccess.com`, and `ACCESS_AUD` to
   the Access application audience. Missing config leaves family APIs closed.
4. Protect `/app`, `/app.js`, `/app.css`, and `/api/pilot/*` using Access with
   email one-time PIN and an explicit pilot allowlist. Keep machine ingestion
   separate from interactive login. Any operator service-token policy must
   apply only to `/api/pilot/operator/*`, never family-data routes.
5. Set a separate random 32-byte hex `PILOT_ADMIN_TOKEN`. Do not reuse the
   read-only status token. `POST /api/pilot/operator/invites` with this bearer
   token, matching `Origin`, `X-Pilot-Request: 1`, and JSON
   `{ "email": "parent@example.com" }`. It returns a private invitation URL
   with the token in its fragment, not in the HTTP URL. Do not log headers,
   response bodies or invitation URLs. Never expose the operator token to the UI.
6. Share a parent's invitation only after the connection work above is ready.
   This branch does not send invitation emails.
7. Revoke a family by setting `pilot_families.revoked_at` to an ISO timestamp
   through a scoped operator database action; membership reads fail immediately.
   Future provider adapters must also revoke that family's credentials/jobs.

Use synthetic fixtures for child-list testing until trusted discovery exists.
Do not manually enter a real second child's mapping and present it as verified.

## Validation

`node --test test/pilot.test.js` exercises RSA-signed synthetic JWTs, real SQLite
migrations, email-bound invitations, two-family isolation, selection, CSRF,
revocation and retained observations. `npm test` includes checker regressions.
`npm run validate` in `worker/` builds without deployment.

`npm run test:pilot-ui` tests phone/desktop layouts, rapid child switching,
saved selection, old successful observations, unavailable data, submission
conflicts, empty accounts and expired sign-in using synthetic browser fixtures.
Screenshots are written outside the repository. No real credentials or
student records are used by these checks.

- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access email one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
