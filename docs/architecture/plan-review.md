# Plan review — November 11, 2026

This review covers the [Cloudflare migration plan](cloudflare.md) and
ADRs 0004 and 0005. The Source decision is recorded as
[ADR 0006](adr/0006-source-access.md).

## Verdict

The plan is sound on identity, credential egress, idempotent runs and
report publication. The Source blocker is specific to Browser Run.
Ordinary Chrome on hosted Linux signs in and reads the same data as the
Mac checker. The plan can stay cloud-only with a second browser runtime
for The Source.

## Why The Source rejects Browser Run

| Evidence | Source |
| --- | --- |
| The Source is fronted by an F5 BIG-IP. “Request Rejected” with a support ID is its firewall response. | Browser Run probe, November 10 |
| Browser Run adds `cf-brapi-devtools`, `cf-biso-devtools`, `Signature-agent`, `Signature` and `Signature-input` to every request. They cannot be removed or overridden. | Cloudflare automatic request headers reference |
| “Requests from Browser Run will always be identified as a bot.” Changing the user agent has no effect on that. | Cloudflare Playwright and FAQ pages |
| Ordinary headless Chrome on hosted Linux reaches the login form. | GitHub-hosted runner and Codespaces, November 10 and 11 |

The hosted passes rule out a general block on data-center addresses.
The rejection follows Browser Run's bot identification or its extra
headers. Treat Browser Run as closed for The Source.

## Probe and sign-in results

| Row | Runner | Public probe | Signed-in read |
| --- | --- | --- | --- |
| A | Mac, Chrome headless | Login form | Daily checker |
| B | Browser Run over CDP | Request Rejected | Not attempted |
| C | GitHub-hosted Linux runner, Chrome 156 | Login form, November 11 | Not attempted |
| D | GitHub Codespace, West US 2, Chrome 157 | Login form, November 10 and 11 | Three fresh automated sign-ins on November 11. One compared with the Mac: roster and grades, missing flags, and attendance matched. |
| E | Cloudflare Containers, ordinary Chrome | Unknown | Unknown |

Both the Mac and the hosted reader had two of nine courses without a
readable assignment table. Rows C and D use Microsoft Azure addresses.
Row E decides whether the Source runner can live on Cloudflare.

`scripts/browser-run/source-probe.js` reports
`portal_session_not_established` separately from
`portal_request_rejected`. The first is the BIG-IP access-session page.
The second is the firewall.

## Findings

| # | Finding | Proposed change |
| --- | --- | --- |
| 1 | The Source needs a browser runtime other than Browser Run. | Run stock Chrome and the existing reader in a hosted container. See ADR 0006. |
| 2 | The hosting platform for that runtime is open. | Test row E. Use Cloudflare Containers if it passes and a small Linux runner elsewhere if it does not. |
| 3 | The plan has no stopping rule if the portal later refuses the hosted browser. | Ordinary, honestly identified browser only. A refusal shows Source as unavailable. No stealth, proxies or header changes. |
| 4 | The evidence covers one account on one day. | Run the operator's own household daily for several weeks and record each outcome before relying on it. |
| 5 | Credential custody for other households is deferred to phase 4. It shapes the design from phase 3. | Decide storage, revocation and deletion before building the web app. Treat many guardian sign-ins from one address as a lockout risk. |
| 6 | Comparison state and Friday baselines still live in Codex chat. | Move state to D1 early. The Worker owns comparisons and reports. |
| 7 | Queues with hand-built leases, fencing and retries are a large surface for a one-family pilot. | Evaluate Workflows for the per-check pipeline and a Durable Object per guardian account to serialize child switching. Keep the D1 and R2 design. |
| 8 | Schoology passed for one guardian through a local CDP controller. The Worker binding is unverified. | Verify the binding and a scheduled run. |
| 9 | The availability target treats providers alike. | Set targets per provider. Show an unavailable or stale provider as a first-class dashboard state. |
| 10 | The hosted verification needs a Mac terminal and a temporary Codespace. | Keep it as a one-time check. The scheduled runner needs its own credential path and its own smoke test. |

## Revised sequence

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 1. Extract local core | Implemented. | Met. |
| 2. Cloud compatibility | Schoology on Browser Run. Source on ordinary hosted Chrome. | Met for one guardian account on GitHub-hosted Linux. Open for Cloudflare Containers and the Browser Run Worker binding. |
| 2a. Source runner | Package stock Chrome and the reader as a container. Run the probe and a verified read from Cloudflare Containers. | Login form and a matching read from the chosen platform on three separate days. ADR 0006 moves to Accepted. |
| 2b. Own the state | Add the D1 schema, report manifest and scheduled checks for both providers. | A week of weekday runs with Codex chat state unused. A Friday PDF regenerates from a recorded snapshot. |
| 3. Web app pilot | Family sign-in, provider connection and reconnect flows, child picker, dashboard. | Both providers update with no guardian device running. Each shows its own verification time. |
| 4. Second household | Invites, revocation, deletion, per-family limits and the credential design. | Two synthetic families stay isolated. A second consenting household completes setup after several weeks of stable single-household runs. |

## Open questions

- Does The Source accept ordinary Chrome from Cloudflare Containers?
- Where do portal credentials live for scheduled runs, and how are they revoked?
- How often does the portal's firewall policy change in practice?
- What retention applies to observations and PDFs once state is hosted?
