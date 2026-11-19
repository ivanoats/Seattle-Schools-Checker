# Parent account connection and child discovery

## Parent flow

An invited parent opens the app on a phone or desktop, signs in through
Access, and connects The Source and Schoology separately. The username/email
stays visible; the password field is masked and cleared immediately on submit.
The app shows queued, discovering, verified or needs-attention status.

Once discovery succeeds, the parent confirms a child from the verified list.
The first confirmation creates a family child. For the other portal, the parent
explicitly chooses either a new child or “Same child as …”. Names alone never
merge identities. No parent edits a configuration file. The existing child
picker remembers the selected child. Disconnect deletes saved credentials,
candidates and provider mappings, and invalidates queued/in-flight jobs. Saved
school observations are retained as historical records with their check times.

## Implemented pipeline

```mermaid
sequenceDiagram
  participant P as Parent browser
  participant W as Private Worker
  participant D as D1
  participant R as Provider runner
  participant S as School portal
  P->>W: Connect selected provider (verified family session)
  W->>D: Encrypted credentials + versioned discovery job
  W-->>P: Queued
  R->>W: Claim one provider-scoped job
  W->>D: Atomic lease; check family and connection revision
  W-->>R: Short-lived job + credentials
  R->>S: Guarded sign-in; rendered linked-child navigation
  S-->>R: Verified child identities
  R->>W: Result bound to job, provider and lease
  W->>D: Check lease/revocation/revision; store candidates
  P->>W: Confirm candidate; optionally link own existing child
  W->>D: Store verified provider mapping
  W-->>P: Child available in picker
```

The Source runner uses stock Chrome on the AWS Linux host. The Schoology
consumer runs in a Worker scheduled invocation with a Browser Run binding.
The minute trigger is for pending onboarding jobs, not the daily school
report schedule. Each invocation claims at most one Schoology job. Browser
work is not placed in HTTP `waitUntil`, whose post-response window is shorter.

Every job gets a new browser/context and closes it after discovery; no sessions,
cookies, traces, screenshots, network captures or student-work exports are kept.
Discovery results contain child identity/mapping only, not grades or assignments.

## Credential and job controls

- AES-256-GCM encrypts both username and password. A random nonce is used per
  submission, with family, provider, connection ID and revision as authenticated
  associated data. Ciphertext cannot be moved to a different family or revision.
- `CONNECTION_KEY` is a Worker secret, separate from D1 and runner tokens. This
  is service-managed encryption, not end-to-end encryption: trusted Worker code
  can decrypt and authorized runners receive credentials in memory over HTTPS.
- Source and Schoology have separate discovery tokens. The Source runner cannot
  claim Schoology jobs. Operator/status tokens do not grant discovery access.
- Machine endpoints require the configured HTTPS app origin. HTTP redirects are
  refused by the Source client. Passwords are submitted only to the approved
  portal destinations by the existing sign-in guards.
- Jobs expire after five minutes; a claimed job has a two-minute, hashed lease.
  Browser work has a 75-second total timeout. An expired job is not retried
  automatically. New sign-ins require an explicit parent submission, with a
  per-connection cooldown and only one pending discovery per connection.
- Every callback checks current family revocation, provider, connection revision
  and lease. Disconnect/reconnect makes old results unusable. No API trusts a
  browser-supplied provider mapping or a cross-family child ID.
- MFA, CAPTCHA, SSO, consent and unsupported child-menu layouts produce attention
  status. This implementation does not bypass them or offer a remote interactive
  browser. Such accounts require a later supported reconnection flow.
- Before rotating `CONNECTION_KEY`, disconnect/reconnect pilot accounts or build
  a versioned re-encryption migration. Replacing the key alone makes stored
  credentials unreadable. Parent credentials are never placed in machine logs.

## Operator rollout (not performed)

Apply migrations 0001–0003 in order, and configure Access as described in
`web-pilot-status.md`. Set independent random 32-byte hex Worker secrets:
`CONNECTION_KEY`, `SOURCE_DISCOVERY_TOKEN`, `SCHOOLOGY_DISCOVERY_TOKEN`.
Configure `BROWSER` and the scheduled trigger in `worker/cloudflare.config.ts`.
Leave `SOURCE_CONNECTIONS_ENABLED` and `SCHOOLOGY_CONNECTIONS_ENABLED` unset
until each deployed runner passes its smoke test. Set each to the string
`true` separately when ready. Disabled connections collect no credentials.

For Source, install the checked-out code and root dependencies on the Linux
host. Store only `discovery-app-origin` and `source-discovery-token` under its
Parameter Store prefix. The discovery host role should read only those two
settings (plus required Session Manager permissions); it does not need the
encryption key or other families' existing Parameter Store passwords.

Use `sh deploy/aws/install.sh <git-ref> discovery` to install without enabling
the legacy scheduled shutdown service. The installer creates the private service
home; systemd grants that state directory write access under `ProtectSystem=strict`.
Smoke test stock Chrome under the deployed service protections before polling.

Install `source-discovery.service` and `source-discovery.timer`, make
`run-discovery.sh` executable and enable the timer only after approval. The
instance must remain running during onboarding availability. The old
`source-runner.service` powers off the instance, and the old scheduler stops it;
do not enable both modes on the same host. Use a dedicated discovery host or
explicitly replace the old stop/start policy. The timer itself never starts a
stopped EC2 instance. Keep Chromium sandboxing enabled; verify Linux user
namespace support rather than adding `--no-sandbox`.

Cloud deployment, secrets, Access activation, EC2 startup/IAM and invitation
delivery are separate approved operations. The first private rollout is recorded
in `web-pilot-status.md`; both providers are enabled for the first live test.

## Validation and remaining launch gates

The synthetic suite covers the real SQLite migrations, encrypted credential
binding, two providers, family isolation, leases, expiry, cooldown, disconnect,
revocation, rendered child menus and duplicate first names. The browser check
uses the actual authenticated API and SQLite to connect both services, confirm
a child, explicitly match portals, select that child and disconnect.

Live child-menu verification is still required. The approved local helpers
successfully completed fresh Source/Schoology checks on November 18, but the
separate structural inspector could not reuse their authenticated sessions.
No live menu structure was verified by that inspection. The adapters accept
Source student-list links and Schoology parent-index child links only, with full
heading/banner verification. Unsupported layouts fail closed; synthetic fixtures
are not evidence that the current production child menu uses those structures.
Do not invite a second household until both live adapters and both deployed
runners pass. Password values and raw session data were never retrieved by the
agent; the approved helpers handled their own existing scoped credentials.

After onboarding, scheduled multi-family grade/assignment collection and hosted
reports remain a separate step. This branch stores provider mappings but does
not yet run recurring checks for newly connected children.

References: [Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/),
[Worker duration limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Source child-menu correction on November 18, 2026

The live parent portal renders ID-less child anchors with a literal
`javascript:switchStudent(number);` href. Clicking the visible anchor submits
`switch_student_form` to `/guardian/home.html` with one hidden
`selected_student_id` field. The initial fixtures used URL/element-ID tabs and
did not represent this layout, so sign-in succeeded but discovery stopped.

Discovery now recognizes that exact link shape and clicks the rendered anchor;
it never evaluates or replays the handler. A page-scoped, single-use guard
allows only the expected top-frame form POST, destination and selected ID.
Extra fields, unrelated POSTs and repeat POSTs remain blocked. The selected tab
and changed full-name heading must agree before a candidate is returned. The
already selected child is verified without posting again. The numeric switch
identity is retained in the validated mapping for subsequent Source reads.

Synthetic regression tests reproduce the original layout failure, exercise the
native form submission with two same-first-name children, reject extra fields
and repeated submissions, and verify mapping persistence through confirmation.
No real child names or portal IDs are included in fixtures.

## Schoology account-menu correction on November 18, 2026

The live modern header identifies its account control with
`data-sgy-sitenav="header-my-account-menu"` and `nav-trigger`; it does not
provide the older `aria-controls` relationship. Opening that visible control
mounts child anchors at `/parent/switch_child/<numeric-id>`. Their first text
line is the full child name and the next line is the school subtitle.

Discovery supports this exact menu marker and same-origin selection path,
retains the older `/parent/index?child=` layout, ignores the school subtitle,
and still requires the full child name to match `child-session-banner` after
navigation. Account/settings links are not child candidates. Extra query
parameters, fragments, credentials in URLs and outside origins are rejected.
Synthetic tests reproduce the original failure with two children, check the
name/banner mismatch case, and preserve the new path through confirmation.

The deployed Source connection and saved child selection were verified in D1
after the first parent retry. Schoology's modern menu was inspected in normal
Chrome; its corrected cloud discovery still requires an explicit parent retry.

The first modern-menu cloud retry still failed despite the correct selector.
A live DOM inspection then identified Schoology's synchronous header bundle at
`https://ui.schoology.com/platform/site-navigation-ui/`. The existing read
policy permitted the app origin and asset CDN but blocked this separate UI
origin, preventing the account menu from rendering. One shared static-asset
policy now covers login and discovery: GET/HEAD only, asset CDN `/assets/`, and
query-free JS/CSS under the exact UI navigation prefix. Other UI paths, data
endpoints and POST requests remain blocked; the password destination remains
`https://app.schoology.com/login`. Discovery waits for the identified header's
account control before inspecting its menu. A regression test now loads the
external header through the real request policy rather than assuming it was
already present in an inline fixture. Another cloud parent retry is needed to
verify the complete corrected path.
