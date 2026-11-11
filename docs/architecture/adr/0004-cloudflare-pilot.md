# ADR 0004 — Pilot on Cloudflare with explicit family and child identity

**Status** Proposed

**Recorded** November 8, 2026

## Context

Guardians need to use the app from phone and desktop browsers, with hosted checks that
run independently of their devices. One guardian may have several linked
students, and multiple households need isolated records.

## Decision

Pilot an invite-only web app with both The Source and Schoology. Use
Browser Run for Schoology, which passed fresh automated sign-in for one
guardian. Validate ordinary hosted Chrome on a separate runner for
The Source before launch.
Confirm each child mapping from the authorized parent view. Use a fresh
isolated context and guard against concurrent child selection within one
guardian account. Verify family-scoped credential access, revocation, and
deletion before adding a second household.

## Alternatives and consequences

Netlify can schedule background jobs with a separate browser service.
A private Linux runner could keep standard Playwright closer to the
current execution model. Browser Run gives the Cloudflare pilot a managed
browser but requires portal compatibility and credential egress tests.
MFA and SSO require a guardian flow that can be completed from a phone or desktop browser.
The pilot will test additional guardian accounts before broadening access.

[Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/).
