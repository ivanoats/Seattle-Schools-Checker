# Plan review — November 10, 2026

This review covers the [Cloudflare migration plan](cloudflare.md) and
ADRs 0004 and 0005. The main proposal is recorded as
[ADR 0006](adr/0006-source-access.md).

## Verdict

The plan is sound on identity, credential egress, idempotent runs and
report publication. Its weak point is sequencing. The release requires
both providers, and The Source cannot be reached from Browser Run. The
next step in the plan tests another hosted browser. That test is worth
one day. It should not sit on the critical path.

## Why The Source rejects Browser Run

| Evidence | Source |
| --- | --- |
| The Source is fronted by an F5 BIG-IP. “Request Rejected” with a support ID is its firewall response. | Browser Run probe, November 10 |
| A plain fetch from a data-center address on November 10 received the BIG-IP access-session page. It did not receive “Request Rejected”. | One request, no JavaScript or cookies |
| Browser Run adds `cf-brapi-devtools`, `cf-biso-devtools`, `Signature-agent`, `Signature` and `Signature-input` to every request. They cannot be removed or overridden. | Cloudflare automatic request headers reference |
| “Requests from Browser Run will always be identified as a bot.” Changing the user agent has no effect on that. | Cloudflare Playwright and FAQ pages |
| Browser Run traffic leaves from Cloudflare address ranges. Per-request rotation is unavailable. | Cloudflare Browser Run FAQ |

The rejection most likely comes from the request's bot identification
or its extra headers. A data-center address alone is a weaker
explanation, given the second row. One request is thin evidence. The
support ID lets the district look up the exact rule.

Browser Run cannot be configured around this. Treat it as closed for The
Source unless the district allowlists it.

## Findings

| # | Finding | Proposed change |
| --- | --- | --- |
| 1 | Both providers gate the release, so the whole web app waits on a third party's firewall. | Decouple collection from reporting with an ingest contract. Ship the dashboard with Schoology hosted and Source collected on the guardian's side. |
| 2 | The “next Source test” changes several variables at once: host, address range, headers and browser build. A pass or fail will not say why. | Run the probe matrix below. It isolates one variable per row. |
| 3 | The plan has no stopping rule. Trying hosts until one passes becomes evasion of a school district's access control. | Adopt the limit in ADR 0006: ordinary browser only, and a rejection is final for that option. |
| 4 | Nobody has asked the district. | Email Source support with the support ID and the use case. This is the only route to hosted access for other households. |
| 5 | Credential custody for other households is deferred to phase 4. It shapes the architecture from phase 3. | Decide before building the web app. Guardian-side collection removes Source passwords from the cloud entirely. |
| 6 | PowerSchool email notifications and other sanctioned channels are untested. | Check the signed-in portal for an email notification setting. If present, test ingestion through an Email Worker. |
| 7 | Comparison state and Friday baselines still live in Codex chat. The cloud plan replaces this last. | Move state first. The Mac checker posts observations to the Worker, which owns comparisons and reports. |
| 8 | Queues with hand-built leases, fencing and retries are a large surface for a one-family pilot. | Evaluate Workflows for the per-check pipeline and a Durable Object per guardian account to serialize child switching. Keep the D1 and R2 design. |
| 9 | Schoology passed for one guardian through a local CDP controller. The Worker binding is unverified. | Verify the binding and a scheduled run before any Source hosting work. It is the path the pilot depends on. |
| 10 | The availability target treats providers alike. | Set targets per provider and per collector. Show staleness on the dashboard as a first-class state. |

## Probe matrix

Use `scripts/browser-run/source-probe.js --label <name>`. It needs no
credentials and makes one request per run. Run each row three times on
different days.

| Row | Runner | Varies | Already known |
| --- | --- | --- | --- |
| A | Mac, Chrome headed | Baseline | Login form |
| B | Mac, Chrome headless | Headless mode | Login form (the daily checker) |
| C | Browser Run over CDP | Cloudflare headers, bot identity, Cloudflare address | Request Rejected |
| D | Hosted Linux VM, ordinary Chrome headless | Data-center address, Linux | Unknown |
| E | Cloudflare Containers, ordinary Chrome headless | Cloudflare address without Browser Run headers | Unknown |

Row D against row C separates the Browser Run identity from a hosted
address. Row E shows whether a Cloudflare-only deployment remains
possible. If D and E are both rejected, stop. Do not add stealth,
proxies or header changes.

The probe now reports `portal_session_not_established` separately from
`portal_request_rejected`. The first is the BIG-IP access-session page
and usually means cookies or JavaScript did not run. The second is the
firewall.

## Revised sequence

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 1. Extract local core | Implemented. | Met. |
| 2a. Own the state | Add the ingest endpoint, D1 schema and report manifest. The Mac checker posts both providers' observations. The Worker computes comparisons and the Friday report. | A week of weekday runs with Codex chat state unused. A Friday PDF regenerates from a recorded snapshot. |
| 2b. Source access decision | Email the district. Check portal email notifications. Run the probe matrix. Time-box to one week of elapsed time. | ADR 0006 moves to Accepted with the chosen collector recorded. |
| 3. Hosted Schoology and dashboard | Verify the Browser Run Worker binding and schedule. Build family sign-in, the dashboard and reconnect flow. Source arrives through ingest. | Schoology updates with no device running. Source shows its own verification time and a clear stale state. |
| 4. Second household | Add invites, revocation and deletion. Add a guardian-side Source collector the household can install, or hosted Source if the district agrees. | Two synthetic families stay isolated. A second consenting household completes setup without sharing a Source password with the service. |

Phase 2a has no dependency on the Source question. It also delivers the
phone-readable dashboard earlier than the current plan.

## Draft note to Source support

Send from the guardian account's email address to
`sourcesupport@seattleschools.org`.

> I am a parent with a guardian account on The Source. I check my own
> children's grades and attendance once each weekday with a small
> personal tool that signs in as me and reads the same pages I see. From
> a cloud-hosted browser the sign-in page returned “Request Rejected”,
> support ID [ID], on November 10, 2026. Is scheduled access by a
> guardian to their own children's records permitted? If so, is there a
> supported way to do it, such as email notifications, the PowerSchool
> mobile app, or an allowlisted address?

## Open questions

- Does The Source expose PowerSchool email notifications to guardians?
- What are the portal's terms on automated or delegated guardian access?
- Which collector can a non-technical household install and keep running?
- What retention applies to observations and PDFs once state is hosted?
