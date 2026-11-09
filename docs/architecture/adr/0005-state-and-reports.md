# ADR 0005 — Preserve verified state and serve private reports

**Status** Proposed

**Recorded** November 8, 2026

## Context

Chat state is useful locally but hard to replay or scope across children.
Hosted schedules can retry or finish out of order. Friday reports need
traceable, per-provider verification times.

## Decision

Persist normalized observations and report manifests in D1. Use unique run
keys, fenced leases and idempotent writes. Keep the last verified baseline
for unavailable sections. Store versioned PDFs in private R2 and authorize
every report read by family membership and child grant.

## Alternatives and consequences

Continuing to use chat for state keeps a Mac dependency. A public report
site would expose private records. Durable storage adds retention, deletion
and restore obligations. Keep Friday publication and baseline advancement
replayable and test the path from duplicate delivery to a single visible
report.
