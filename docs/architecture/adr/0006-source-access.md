# ADR 0006 — Collect Source data from the guardian's side until hosted access is permitted

**Status** Proposed

**Recorded** November 10, 2026

## Context

The Source sits behind an F5 BIG-IP. It returned a “Request Rejected”
page with a support ID to Cloudflare Browser Run before any credentials
were entered. Browser Run attaches identifying headers that cannot be
removed, signs each request, and is always classified as a bot. Its
traffic leaves from Cloudflare address ranges with no alternative egress.
No Browser Run setting changes this outcome.

ADR 0004 makes both providers a release requirement. That ties the web
app to the one dependency the project does not control.

## Decision

Separate collection from reporting. The Worker accepts versioned
observations through an authenticated ingest endpoint, whichever
collector produced them. Reports show each provider's own verification
time and coverage.

Collect Schoology on Browser Run. Collect The Source on the guardian's
side, starting with the existing Mac checker. A hosted Source collector
is added only when one of these holds:

1. Seattle Public Schools confirms that scheduled guardian access from
   a hosted service is acceptable, or allowlists the runner.
2. An honestly identified, ordinary Chrome on a hosted runner reaches
   the login form repeatedly, and the use stays within the operator's
   own household.

The project does not use stealth plugins, fingerprint or header
spoofing, residential or rotating proxies, or CAPTCHA solving to reach
either portal. A rejection from an ordinary browser is a final answer
for that hosting option.

Hosted Source credentials for a second household require the first
condition. Signing in to many guardian accounts from one hosted address
resembles credential stuffing and can lock real parents out.

## Alternatives and consequences

Moving the Source runner to another cloud until one passes is fragile.
The firewall policy can change without notice, and the approach turns
into evasion as soon as an ordinary browser is refused. Routing a hosted
browser through a home connection works for one household and still
needs a device at home.

Guardian-side collection keeps Source credentials out of the cloud and
uses the network and browser the portal already accepts. Source data can
go stale when the guardian's device is off. The dashboard must show that
plainly. The availability target in the quality assessment applies per
provider. A second household needs a collector it can install, such as a
browser extension, before it can add The Source.

PowerSchool can email grade and attendance summaries to guardians where
a district enables it. If The Source offers this, an Email Worker can
ingest those messages with no credentials and no browser. District
pages do not mention the feature. Check the signed-in portal.

[Automatic request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/) ·
[Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/) ·
[Email Workers](https://developers.cloudflare.com/email-routing/email-workers/).
