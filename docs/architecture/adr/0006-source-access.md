# ADR 0006 — Read The Source with ordinary hosted Chrome

**Status** Accepted for the single-household pilot

**Recorded** November 10, 2026. Revised November 11, 2026.

## Context

The Source sits behind an F5 BIG-IP. It returned a “Request Rejected”
page with a support ID to Cloudflare Browser Run before any credentials
were entered. Browser Run attaches identifying headers that cannot be
removed, signs each request, and is always classified as a bot. No
Browser Run setting changes this outcome.

Ordinary headless Chrome on hosted Linux is accepted. On November 11 the
public sign-in probe reached the login form from a GitHub-hosted runner
and from GitHub Codespaces. Three Codespace runs then completed a fresh
automated sign-in and a verified read. The third was compared with the
Mac checker and matched on roster and grades, missing flags, and
attendance. Both readers had two of nine courses without a readable
assignment table.

Checks must run with no guardian device switched on. Collection on a
Mac, a home machine or a browser extension is out of scope.

## Decision

Use AWS EC2 in Oregon (`us-west-2`) for The Source, with stock Chrome
and the existing Playwright reader. Keep Schoology on Cloudflare Browser Run.
The [AWS runner and Worker client](../../../scripts/source-runner/README.md)
exchange the same versioned observation the local checker emits.

On November 11, Ubuntu EC2 with Chrome 157 reached the public login form,
completed fresh automated sign-in, verified the selected child, and read
grades and attendance. Assignment coverage matched the Mac on all nine
rows. Seven had readable detail and two support rows exposed no published
grade link. This compares coverage on EC2. The earlier Codespace test also
compared record values.

The AWS service listens on loopback. The planned Cloudflare Tunnel and
Access policy will carry authorized Worker jobs to it without inbound
EC2 rules. The Worker sends an opaque child ID and service credentials.
The AWS process resolves the child mapping and Source credentials locally.
The deployed service and scheduled dispatch still need an end-to-end check.

The browser identifies itself honestly. The project does not use
stealth plugins, fingerprint or header spoofing, residential or rotating
proxies, or CAPTCHA solving. If the portal starts refusing the hosted
browser, Source data is shown as unavailable until a permitted route
exists.

Sign in once per scheduled check for each guardian account. Do not
retry a rejected sign-in automatically.

## Alternatives and consequences

Browser Run for both providers would be simpler and is refused by the
portal. Guardian-side collection keeps Source passwords out of the cloud
and needs a device that is on. PowerSchool email notifications would
need no credentials. District pages do not mention them, and they would
not carry assignment-level missing flags.

The evidence covers one guardian account, one day, and the tested AWS and Microsoft Azure
addresses. The firewall policy can change without notice. The dashboard
shows Source verification time and an unavailable state separately from
Schoology. The availability target applies per provider.

Hosting other households' Source credentials remains a separate
decision. Many guardian sign-ins from one hosted address can resemble
credential stuffing and lock parents out. Run the operator's own
household for several weeks first, and settle credential storage,
revocation and deletion as ADR 0004 requires.

[Automatic request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/) ·
[Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/) ·
[Containers](https://developers.cloudflare.com/containers/).
