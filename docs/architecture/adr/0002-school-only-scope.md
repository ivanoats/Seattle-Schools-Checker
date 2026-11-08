# ADR 0002 — Scope the monitor to school data

**Status** Accepted

**Recorded** November 8, 2026

## Context

The multi-child product is for school monitoring. Sugarmate is specific to
one family's separate health workflow.

## Decision

Use Source and Schoology in default setup and scheduled checks.
Shelf Sugarmate and exclude it from the cloud build, normalized schema,
credential setup and reports.

## Alternatives and consequences

A per-child health feature flag would add consent, secrets, reporting and
access-control requirements to the shared product. Retain the existing
local implementation and tests as a reversible shelf. Local credentials
and historical records remain in their current locations. Any future health
integration needs a separate scope and decision record.
