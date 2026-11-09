# Current architecture

The school checker is a local read-only workflow for one configured student per invocation.
The code baseline is commit `0312de9`, with the school-only operating scope
adopted on November 8, 2026. The schedule is weekdays at 5 p.m. Seattle time.
Friday runs also produce a family PDF.

## C4 level 1 — System context

```mermaid
C4Context
    title Current system context
    Person(guardian, "Guardian", "Reviews school progress and completes interactive login")
    System(checker, "Seattle Source checker", "Read-only school checks and family reports")
    System_Ext(source, "SPS The Source", "Grades, assignment flags and attendance")
    System_Ext(schoology, "Schoology", "Due dates, submissions and course materials")
    Rel(guardian, checker, "Sets up parent sign-in and reads reports")
    Rel(checker, source, "Reads guardian pages", "HTTPS")
    Rel(checker, schoology, "Reads parent pages", "HTTPS")
```

## C4 level 2 — Containers on the Mac

```mermaid
C4Container
    title Current local containers
    Person(guardian, "Guardian")
    System_Ext(portals, "Source and Schoology", "Parent portals")
    System_Boundary(local, "Local school monitoring") {
        Container(codex, "Codex heartbeat and chat", "Local automation", "Schedules checks, compares snapshots and prepares the Friday PDF")
        Container(helper, "Checker CLI", "Swift and shell", "Retrieves scoped credentials when needed")
        Container(worker, "Browser worker", "Node.js and Playwright", "Authenticates, verifies student identity and extracts records")
        Container(browser, "Chrome", "Private persistent profiles", "Keeps service sessions and renders portal pages")
        ContainerDb(keychain, "Login Keychain", "macOS", "Scoped credential entries")
        ContainerDb(reports, "Family PDFs", "Local files", "Dated reports")
    }
    Rel(guardian, codex, "Receives school updates and reports")
    Rel(guardian, helper, "Enters credentials in a native dialog")
    Rel(codex, helper, "Invokes checks and consumes JSON")
    Rel(helper, keychain, "Reads the requested entry after a session miss")
    Rel(helper, worker, "Sends a request over stdin")
    Rel(worker, browser, "Drives isolated service profiles")
    Rel(browser, portals, "Navigates rendered pages", "HTTPS")
    Rel(codex, reports, "Writes the Friday report")
```

The chat supplies comparison state, notification history, report wording,
and occasional verification in the guardian's regular Chrome session.
The repository provides the checker, tests and a portable JSON report model.
Friday PDF composition and the schedule live in the surrounding Codex workflow.
The checker preserves the original report and adds a versioned observation.

## C4 level 3 — Browser worker components

```mermaid
C4Component
    title Current browser worker components
    Container_Ext(helper, "Native checker CLI", "Swift")
    Container_Ext(browser, "Chrome", "Playwright-controlled browser")
    Container_Boundary(worker, "Node.js browser worker") {
        Component(entry, "Request and lifecycle", "src/worker.js", "Dispatch, service lock, browser lifecycle, sanitized JSON")
        Component(auth, "Authentication", "src/auth.js", "Session checks and credential request restrictions")
        Component(source, "Source reader", "src/source.js", "Verifies student, reads grades, flags and attendance")
        Component(schoology, "Schoology reader", "src/schoology.js", "Verifies student and reads parent summary")
    }
    Rel(helper, entry, "Supplies service and operation")
    Rel(entry, auth, "Establishes portal session")
    Rel(entry, source, "Dispatches Source check")
    Rel(entry, schoology, "Dispatches Schoology check")
    Rel(auth, browser, "Signs in on allowed destinations")
    Rel(source, browser, "Reads Source DOM")
    Rel(schoology, browser, "Reads Schoology DOM")
```

## Boundaries in the code

| Layer | Current implementation |
| --- | --- |
| Domain rules | Portal evidence is normalized in `src/core/observations.js`. The portable family model compares verified observations and classifies deadlines and submission evidence. |
| Use cases | Service checks in `src/worker.js`. The existing Friday baseline and PDF remain in Codex. |
| Adapters | Portal-specific readers in `src/source.js` and `src/schoology.js`. Both accept a Playwright page and use portal selectors. |
| Drivers | `bin/checker`, the Swift Keychain helper, Playwright and Chrome. |

The helper first tries the saved session. A `credentials_required` response
causes a second run with the requested credentials sent through a private
pipe. The worker uses a per-service file lock and closes Chrome on normal
exit. An abrupt process exit can leave a stale lock.

Source verifies the selected student in grade and detail headings. It
preserves unavailable assignment tables as unknown. Schoology requires
the student banner and reads visible overdue, upcoming and completed rows.
Detailed submissions can require a separate read in normal Chrome. Source
missing flags and Schoology overdue or submitted evidence retain their
separate meanings.

Sugarmate remains in the local source tree as a shelved integration.
The active schedule and default credential setup omit it. See
[ADR 0002](adr/0002-school-only-scope.md).
