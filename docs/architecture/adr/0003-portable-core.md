# ADR 0003 — Separate portal readers from execution and report policy

**Status** Accepted for the local implementation

**Recorded** November 8, 2026

## Context

The two portal readers have different semantics. The original child selection was fixed and change detection depended on
prompt and chat state. A cloud rewrite
would risk changing current behavior.

## Decision

Keep portal adapters behind a child-scoped observation contract with
identity, provenance, term, time and coverage. Extract pure comparison,
deadline and reporting rules. Use narrow interfaces for browser startup,
credential retrieval, state and artifact publication. Retain the local CLI
as the current driver. Add the cloud driver in a later phase.

## Alternatives and consequences

A direct port of the worker would be smaller initially and would carry
local assumptions into the cloud. A full framework rewrite would add
migration risk. The proposed extraction adds a schema and contract tests.
It allows the same fixtures to verify local and cloud outputs, including
the differences between a missing flag and a submitted item.

The local worker emits a versioned observation alongside its legacy report.
The portable report model reads those observations. Friday PDF composition
and existing scheduled comparisons still run in Codex.
