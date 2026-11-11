# Browser Run compatibility check

Run from the repository root with Node.js and the existing Playwright
dependency. Supply a Cloudflare API token scoped to the test account with
Browser Rendering Edit permission through the local environment. The
runner uses `CLOUDFLARE_ACCOUNT_ID` when set. Otherwise it uses the single
account returned by `cf auth whoami`.

```sh
node scripts/browser-run/check.js
node scripts/browser-run/check.js --local
```

The remote command connects to Cloudflare Browser Run over CDP. It creates
one temporary browser session with recording disabled and a policy that
blocks all HTTP and HTTPS egress. An independent navigation verifies the
policy. The test serves portal-shaped pages through Playwright interception.
It sends synthetic form POSTs to a loopback fixture and closes the cloud
session after the run. The local command uses installed Chrome with
hostname resolution blocked.

Both commands exercise the existing login guard and readers. The fixtures
cover two students with overlapping names, active Source missing icons,
ungraded rows, attendance, Schoology overdue expansion and submission
evidence, wrong-child rejection, Seattle browser time, and blocked unsafe
redirects. The login guard must produce a same-origin 303. The test then
navigates to the synthetic landing page with a fresh GET because Playwright
does not route every request in an HTTP redirect chain.

The result reports scenario names and total wall time. The fixture has no
real accounts or records. This checks remote Chromium through CDP. The
Worker browser binding, real portal redirects, account challenges, and
live parity still need verification before a scheduled deployment.

## One-time live login

Use the same Cloudflare token setup and the Mac checker's private child
configuration. Start with Schoology in an interactive Mac terminal:

```sh
node scripts/browser-run/live.js schoology
```

Open the short-lived Live View link shown in your terminal and sign in on the
school portal. Complete any prompt yourself. In Schoology, select the configured
child. Return to the terminal and press Enter. Close the Live View tab when
finished. Keep the link private because it grants access to the browser.

The runner verifies the child before reading, closes the cloud session, then
compares the selected fields with the local checker. Share only the final JSON
status. The script does not request school credentials, print school records,
or record the browser session. The check validates manual sign-in from
Cloudflare and read parity. Scheduled reauthentication and the Worker binding
require separate verification.

The Source returned a “Request Rejected” page before sign-in in the first
Cloudflare probe on November 10, 2026. The same runner accepts `source`
for a later recheck and exits if it sees that rejection.

## One-time unattended Schoology login

```sh
node scripts/browser-run/live.js schoology --unattended
```

Enter the parent email and password at the terminal prompts. Only the password is hidden. The
runner starts a fresh Cloudflare browser and submits the form once from
that browser. It verifies the exact Schoology login destination, blocks
redirects that could replay the login POST, and reports a status if the
portal requires intervention. After sign-in, it verifies the configured
child before reading. Share only the final JSON status. The runner keeps
the credentials in memory for that attempt and disables session recording.

## Public Source sign-in probe

On the candidate hosted Linux runner, install the repository dependencies
and standard Chrome for Playwright. Run this from the repository root:

```sh
node scripts/browser-run/source-probe.js
```

The probe visits the public sign-in URL and checks for the expected login
form. It distinguishes the portal’s rejection page from a genuine form,
even when both return HTTP 200. It uses no account credentials.

Add `--label <name>` to name the runner in the output and `--headed` to
show the browser. The result is `login_form_reached`,
`portal_request_rejected` (firewall, with a support ID when shown),
`portal_session_not_established` (the BIG-IP access-session page) or
`login_page_unverified`. Use an ordinary browser only. A rejection is a
final answer for that runner. See
[ADR 0006](../../docs/architecture/adr/0006-source-access.md).
