# Invite-only web pilot

## Implementation

This branch contains the invitation/dashboard foundation and account connection
pipeline. The first private Cloudflare deployment is configured; live parent
sign-in and child discovery still need verification before another family joins.

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
- Account connection and child discovery are implemented behind per-provider
  readiness flags. Parents enter credentials, receive verified child choices and
  explicitly confirm cross-portal matches. See [account connections](account-connections.md)
  for encryption, runner setup, tests and remaining live verification gates.
- Existing runner ingestion, local Keychain, checks and report workflows are
  unchanged. The existing runner is not enrolled in the new membership tables.

## Private rollout on November 18, 2026

- PR #5 contains the pilot implementation and reconciles the existing Source
  runner squash merge on `main`.
- Cloudflare migrations 0001–0003 are applied. The Worker has Browser Run,
  the minute-by-minute discovery consumer, encrypted connection storage and
  separate discovery secrets. Existing single-family secret bindings remain.
- Access is activated with email one-time PIN and one explicitly allowed pilot
  identity. Signed-out `/app` and `/api/pilot/children` requests redirect to
  Access. No second household has been invited. A seven-day invitation for the
  operator's test identity was accepted; no invitation tokens are in the repository.
- A Browser Run smoke test loaded Schoology's public login form and found the
  password input. Schoology account connection is enabled for the private live
  test. The subsequent live parent retry completed automated sign-in and child
  discovery successfully after the static-header request policy correction.
- The AWS operator permission blocker was resolved. The Oregon probe host now
  runs a dedicated discovery service and 15-second polling timer. Its instance
  role has Session Manager support and an explicit deny on reading Parameter
  Store values outside the two discovery settings. Those settings contain only
  the app origin and machine token, never portal credentials.
- Stock Chrome loaded the Source login form with HTTP 200 using the service
  account, Chromium sandbox and the same systemd protections as deployment.
  An authenticated queue poll returned `idle`. The runner received a private
  writable home to fix an observed Chrome crash; no sandbox was disabled.
  Both provider connection forms are now enabled for the first private test.
- The instance remains running during pilot onboarding. The legacy power-off
  service and old scheduled run mode are not enabled on this host.
- Both provider connections now show `ready`, with no failure reason. Parent
  confirmation linked both to the same selected child; the saved mappings were
  independently read back. No password values or raw session data were retrieved
  by the agent. Existing local checks and report workflows were not changed.

Evidence: migration records, Worker deployment and secret-binding names,
Access application/policy responses, signed-out HTTP smoke tests, Browser Run
login-form rendering, AWS installation and sandbox/service verification, and
D1 connection/mapping readback after parent confirmation. Successful onboarding
does not establish recurring multi-family collection or reporting.

## Required before another household can onboard

| Work | Exit evidence |
| --- | --- |
| Verify live AWS/Cloudflare state | Authenticated deployment status and approved deployed smoke test |
| Deploy Access and invitation flow | Parent opens an invitation and receives an email code from a phone |
| Family-scoped provider accounts (deployed, first parent verified) | Encrypted credentials, revocation/deletion, isolated sessions and sign-in limits tested synthetically |
| Source discovery on AWS (first parent verified) | Deploy the discovery service; verify the production child menu and each full identity |
| Schoology on Browser Run (first parent verified) | Deploy the binding/consumer; verify production child menu and unsupported challenge behavior |
| Trusted child discovery ingestion (implemented) | Verify deployed provider tokens, leases and identity-bound confirmation |
| Multi-family collection | Replace single-family ingest configuration with family/account-scoped job claims and runner authorization |
| Hosted schedule and reports | School-calendar-aware jobs, comparisons and private PDFs independent of local Codex |
| Second household acceptance | Parent connects both services, selects her son, sees verified records and revokes access without help |

ADR 0006's live provider tests were for one parent account. They establish
host compatibility, not readiness for a second family.

## Operator setup for this slice

Do these steps only after deployment approval. Parents do not execute them.

1. Install dependencies at the repository root and in `worker/`. The root
   package supplies the JWT verifier to both the tests and Worker build.
2. Apply migrations 0001–0003 in order.
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

Use synthetic fixtures until live discovery is verified on both hosts.
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

The corrected rollout passed 64 tests and both browser suites. SonarCloud,
GitGuardian and Socket checks passed after the temporary-directory and startup
promise findings were fixed. DeepSource JavaScript still reports quality
findings; PR #5 is not represented as fully green or ready to merge.
