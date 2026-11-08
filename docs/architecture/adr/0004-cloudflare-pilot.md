# ADR 0004 — Pilot on Cloudflare with explicit family and child identity

**Status** Proposed

**Recorded** November 8, 2026

## Context

A hosted run should work while the Mac is offline. One parent account may
have several linked students. Display names alone are ambiguous.

## Decision

Pilot one private family deployment using Workers, Browser Run and scoped
Worker Secrets. Confirm each provider child mapping from the authorized
parent view. Use a fresh isolated context and guard against concurrent
child selection within the same guardian account.

## Alternatives and consequences

Netlify can schedule background jobs with a separate browser service.
A private Linux runner could keep standard Playwright closer to the
current execution model. Browser Run gives the Cloudflare pilot a managed
browser but requires portal compatibility and credential egress tests.
MFA and SSO require guardian action. Multi-family credential storage is
a separate decision before onboarding other households.

[Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/).
