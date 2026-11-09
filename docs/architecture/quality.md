# Quality attribute assessment

This is a source and workflow review. The cloud targets below are proposed
acceptance criteria. They are separate from observed production performance.

| Attribute | Current assessment | Proposed requirement and verification |
| --- | --- | --- |
| Modularity | Portal extraction is separated. The worker owns dispatch, auth, locks and Mac-specific Chrome startup. The portable core handles comparisons and report data. Codex still manages scheduled comparisons and Friday PDFs. | Run the same domain and report fixtures through local and cloud drivers. Pure comparison and report code imports no Playwright, Swift or Worker bindings. |
| Customizability | Student mappings live in private local configuration. Service allowlists, Seattle time and scheduled report preferences are set in code or automation instructions. | Configure verified children, providers, timezone and report preferences per family. Add a second child through setup without code edits. Validate configuration before a run. |
| Correctness | Identity checks and missing icons are useful safeguards. Some summary data is partial. Source flags and Schoology submission evidence can disagree. | Preserve provider, term, evidence and coverage. Fixture tests cover same-name students, missing versus overdue, collected work, overlapping receipts, blank new terms and Friday deadlines. Unknown data never advances the affected baseline. |
| Observability | The checker returns a status, phase and bounded diagnostics. Run history and deduplication live in chat. | Correlate attempts, duration, outcome, coverage, auth challenges, report generation and browser consumption by opaque run ID. A dashboard distinguishes stale data, a failed run, no changes and a user action. |
| Reliability | Sessions can expire. Interactive login and stale file locks can interrupt runs. | Give each child/provider check an independent outcome. Retry transient errors within a bounded budget. Route CAPTCHA, MFA and credential failures to a guardian action. Replay duplicate jobs without duplicating reports or changes. |
| Availability | Collection and reporting depend on the local execution environment. | For the pilot, target 95% of configured weekday child/provider checks with a verified result within 30 minutes of the scheduled time over 20 weekdays. Count auth blockers and missed invocations in the denominator. |
| Security | Keychain scopes credentials by service. Current readers verify one student and trust a local user boundary. | Verify authorization for each tenant, child and report on every request. Test wrong-child and cross-tenant access failures. Verify credential egress, redirect handling and absence of sensitive log or replay artifacts before live sign-in. |
| Privacy | Reports are local. A shelved health adapter remains in the repository. | Cloud build and schemas cover school data only. Prove access revocation, deletion, bounded retention and private artifact access. Audit access without storing student records in logs. |
| Performance and cost | Per-course pages and asynchronously loaded summaries drive variable latency. No timing or cost baseline was measured. | Measure browser seconds, page counts and end-to-end p50/p95 for two children. Cap concurrent runs and browser seconds per family. Confirm pilot budget against current account limits before enabling retries at scale. |
| Portability | Standard JS readers use Playwright. The CLI depends on AppKit, Keychain, persistent profiles and filesystem locks. | Swap browser, credentials, state and schedule drivers behind explicit interfaces. Run the existing local CLI with the new core during the cloud pilot. |
| Maintainability and testability | Existing synthetic tests cover selected auth, DOM and parsing cases. Live portal markup is an external dependency. | Version normalized observations and fixtures. Keep adapter-specific selectors and error classifications together. Exercise each portal contract with synthetic fixtures plus authorized smoke checks. |
| Recoverability | Reports and prior comparisons are recoverable from local files and chat. No repository-owned checkpoint exists. | Restore a test copy and regenerate a Friday report from a versioned verified snapshot. Exercise expired leases, a retry during report writes, deletion, and rollback to the local runner. |
| Usability and accessibility | The family PDF is readable and separates submission evidence from missing work. It needs local creation. | Make check time, stale sections and required action visible. Verify readable keyboard navigation and accessible status text in the hosted report view. |

## Priority and evidence

Identity and credential protection are release gates. A run with an
unverified student must stop before extracting or committing records.
Correctness comes next because a false clearance or missed hand-in changes
the family's next action. Scheduling and latency targets matter once those
checks pass.

Use structured events such as `run.started`, `provider.checked`,
`provider.needs_action` and `report.ready`. Allowlist fields such as
`run_id`, provider, stage, outcome, duration and parser version. Keep
credentials, cookies, student names, portal URLs with identifiers, raw DOM,
assignment titles and report bodies outside diagnostic logs. Verify the
deployed logging and tracing configuration against these rules.
[Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
