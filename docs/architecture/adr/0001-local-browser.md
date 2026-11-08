# ADR 0001 — Record local browser and credential boundaries

**Status** Accepted, existing architecture

**Recorded** November 8, 2026

## Context

The checker uses parent-facing pages on Source and Schoology.
The local workflow requires an authenticated browser and student verification.

## Decision

Use a signed macOS Keychain helper and separate persistent Chrome profiles.
Try the saved session first. Send credentials through the helper's private
pipe when reauthentication is necessary. Return read-only JSON to Codex.

## Alternatives and consequences

A manually signed-in browser reduces credential handling but requires
routine intervention after expiration. A provider API would require
confirmed parent-access permissions and equivalent data coverage.
The adopted design supports local reauthentication and ties browser
startup, credential storage and part of recovery to the Mac.
