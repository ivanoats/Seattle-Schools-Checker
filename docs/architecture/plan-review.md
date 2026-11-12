# Plan review — November 11, 2026

This review covers the [Cloudflare migration plan](cloudflare.md) and
ADRs 0004 and 0005. The Source decision is recorded as
[ADR 0006](adr/0006-source-access.md).

## Verdict

The plan is sound on identity, credential egress, idempotent runs and
report publication. The Source rejected both tested Cloudflare browser routes.
Ordinary Chrome on AWS Oregon signs in and reads Source. Its per-course
assignment coverage matched the Mac checker. The plan can stay cloud-only with a second browser runtime
for The Source.

## Why The Source rejects Browser Run

| Evidence | Source |
| --- | --- |
| The Source is fronted by an F5 BIG-IP. “Request Rejected” with a support ID is its firewall response. | Browser Run probe, November 10 |
| Browser Run adds `cf-brapi-devtools`, `cf-biso-devtools`, `Signature-agent`, `Signature` and `Signature-input` to every request. They cannot be removed or overridden. | Cloudflare automatic request headers reference |
| “Requests from Browser Run will always be identified as a bot.” Changing the user agent has no effect on that. | Cloudflare Playwright and FAQ pages |
| Ordinary headless Chrome on hosted Linux reaches the login form. | GitHub-hosted runner and Codespaces, November 10 and 11 |

The GitHub-hosted passes show that some data-center addresses are
accepted. Stock Chrome on Cloudflare Containers also received a firewall
rejection, so Browser Run identification alone cannot explain the
observed results. The exact firewall rule is unconfirmed.

## Probe and sign-in results

| Row | Runner | Public probe | Signed-in read |
| --- | --- | --- | --- |
| A | Mac, Chrome headless | Login form | Daily checker |
| B | Browser Run over CDP | Request Rejected | Not attempted |
| C | GitHub-hosted Linux runner, Chrome 156 | Login form, November 11 | Not attempted |
| D | GitHub Codespace, West US 2, Chrome 157 | Login form, November 10 and 11 | Three fresh automated sign-ins on November 11. One compared with the Mac: roster and grades, missing flags, and attendance matched. |
| E | Cloudflare Containers, ordinary Chrome | Request Rejected (HTTP 200), November 11 at 12:32 p.m. Pacific. Support ID `10160004216154572881`. [Probe](../../scripts/source-container/README.md) | Not attempted |
| F | AWS EC2 Oregon, Ubuntu, Chrome 157 | Login form, November 11 at 12:53 p.m. Pacific | Fresh automated login and verified grades and attendance read. The 1:34 p.m. coverage check matched the 1:19 p.m. Mac check on all nine rows. |

Seven rows had readable assignment details, including Advisory. School
Counselor HS and Program Support showed no published grade link on either
runner. The AWS test compared coverage by row. The Codespace comparison
covered record values as well. This establishes single-account compatibility
on the tested date and IP address.

`scripts/browser-run/source-probe.js` reports
`portal_session_not_established` separately from
`portal_request_rejected`. The first is the BIG-IP access-session page.
The second is the firewall.

## Findings

| # | Finding | Proposed change |
| --- | --- | --- |
| 1 | The Source needs a browser runtime other than Browser Run. | Run stock Chrome and the existing reader on AWS EC2 in Oregon. See ADR 0006. |
| 2 | The Source rejected stock Chrome on Cloudflare Containers. | Use the verified AWS Oregon EC2 host for the pilot. |
| 3 | The plan has no stopping rule if the portal later refuses the hosted browser. | Ordinary, honestly identified browser only. A refusal shows Source as unavailable. No stealth, proxies or header changes. |
| 4 | The evidence covers one account on one day. | Run the operator's own household daily for several weeks and record each outcome before relying on it. |
| 5 | Credential custody for other households is deferred to phase 4. It shapes the design from phase 3. | Decide storage, revocation and deletion before building the web app. Treat many guardian sign-ins from one address as a lockout risk. |
| 6 | Comparison state and Friday baselines still live in Codex chat. | Move state to D1 early. The Worker owns comparisons and reports. |
| 7 | Queues with hand-built leases, fencing and retries are a large surface for a one-family pilot. | Evaluate Workflows for the per-check pipeline and a Durable Object per guardian account to serialize child switching. Keep the D1 and R2 design. |
| 8 | Schoology passed for one guardian through a local CDP controller. The Worker binding is unverified. | Verify the binding and a scheduled run. |
| 9 | The availability target treats providers alike. | Set targets per provider. Show an unavailable or stale provider as a first-class dashboard state. |
| 10 | The AWS compatibility check used a Mac terminal for credential entry. | Keep it as a one-time check. The scheduled runner needs its own credential path and its own smoke test. |

## Revised sequence

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 1. Extract local core | Implemented. | Met. |
| 2. Cloud compatibility | Schoology on Browser Run. Source on ordinary hosted Chrome. | Met for one guardian account on AWS Oregon and GitHub-hosted Linux. Cloudflare Containers failed the public probe. The Browser Run Worker binding remains open for Schoology. |
| 2a. Source runner | Validate stock Chrome and the reader on a separate Linux host. | AWS selected for the single-household pilot. Verify the deployed Worker-to-EC2 path and repeat live reads on separate days. |
| 2b. Own the state | Add the D1 schema, report manifest and scheduled checks for both providers. | A week of weekday runs with Codex chat state unused. A Friday PDF regenerates from a recorded snapshot. |
| 3. Web app pilot | Family sign-in, provider connection and reconnect flows, child picker, dashboard. | Both providers update with no guardian device running. Each shows its own verification time. |
| 4. Second household | Invites, revocation, deletion, per-family limits and the credential design. | Two synthetic families stay isolated. A second consenting household completes setup after several weeks of stable single-household runs. |

## Open questions

- Will the deployed Worker-to-EC2 path sustain verified reads across multiple days?
- Where do portal credentials live for scheduled runs, and how are they revoked?
- How often does the portal's firewall policy change in practice?
- What retention applies to observations and PDFs once state is hosted?
