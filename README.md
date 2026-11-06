# Seattle Source checker

Private, local checks for a parent’s SPS Source and Sugarmate accounts, with macOS Keychain sign-in. Passwords are entered into a native secure dialog, stored in login Keychain, and passed through a private pipe to a fixed local browser worker only when a session needs reauthentication. There is no secret-export command. CLI output contains status or the requested school/glucose summary, never credentials.

## Setup

Requires macOS, Xcode command-line tools (or Xcode), Node.js 22+, and installed Google Chrome.

```sh
npm ci
npm run build
npm run setup:keychain
```

Enter the Source parent username/password, then the Sugarmate email/password in the two local macOS dialogs. Do not enter passwords into the terminal or chat. Keychain may request approval for the signed helper. Approving persistent access to these two items allows unattended re-login while login Keychain is unlocked. macOS can request approval again after rebuilding/signing the helper.

This creates **new, scoped Keychain items**. It does not read existing Apple Passwords/1Password entries or change their settings. The helper is signed locally (ad hoc); it is not notarized or a sandboxed app. The native helper uses the macOS login-Keychain ACL API, which Apple marks deprecated but still supports for this desktop use case. Credential and session protection is within your macOS user account; malicious code already running as your user could modify this project. Keep the repository and its dependencies under your control.

## Commands

```sh
./bin/checker status source
./bin/checker status sugarmate
./bin/checker login source
./bin/checker login sugarmate
./bin/checker check source
./bin/checker check sugarmate 2026-11-05
```

`status` checks only whether the scoped Keychain entry exists. `login` verifies the session or signs in and returns status. `check source` selects Sample and returns grades, active missing flags, attendance and tardies. Grade percentages and letter grades remain as published; callers must handle inconsistent values and term transitions. An unavailable assignment table is explicitly marked unavailable.

`check sugarmate` accepts up to seven dates and returns aggregate ranges, observed high/low intervals, sample coverage, school periods, prior evening (6–11 p.m.), and overnight (11 p.m.–school start). The feed labelled Sample Account was confirmed by Ivan to be Sample’s. It reads the configured range each time. It reads plotted points, not a raw CGM export; timestamps are approximate and values at 400 may be clipped. It never fills missing readings. Outputs use UTC ISO timestamps with the Seattle timezone stated; convert to Seattle time for reports. Verify date-specific school announcements before accepting standard class windows. Geometry includes both lunch possibilities; Tuesday/Thursday Biology’s last ten minutes remain uncertain. These observations do not establish the cause of an absence or supply treatment advice.

`check` runs headlessly; `login` opens Chrome and waits up to three minutes for you to complete any account setup, MFA, or consent yourself. Both use separate private profiles under `~/Library/Application Support/SeattleSourceChecker/` (directory mode 700). Cookies are sensitive session credentials; profiles stay outside the repository. Neither Chrome’s normal profile nor its debug port is used. The worker does not capture screenshots, network traces, videos, console logs, or password-containing exception messages. Source credentials are restricted to its exact HTTPS origin; Sugarmate credential requests are restricted to its observed HTTPS OAuth token endpoint. Sugarmate’s country selection is set to US for this Seattle-based workflow.

## Weekday automation

The existing Codex weekday automation should call the absolute project command `bin/checker check source` first, use the latest successful chat result as its comparison baseline, then call `bin/checker check sugarmate YYYY-MM-DD ...` for new/changed absence dates. These commands retrieve credentials internally; never call the macOS `security` CLI to print credentials. No automated email or school-record changes are implemented.

If the helper returns `setup_required`, run setup locally. For `keychain_access_required`, unlock/approve the scoped entry locally. `sign_in_needs_attention` means the login was not verified (invalid credentials, MFA, CAPTCHA, or a changed page); the checker does not bypass those challenges. `check_already_running` avoids overlapping access to a profile. If a process is force-killed its service `.lock` may need manual removal after verifying no checker process remains. `check_failed` is intentionally generic to avoid leaking browser data.

Both scoped Keychain entries and live sign-ins were verified on November 6, 2026. Live Source extraction and a dated Sugarmate comparison also passed. The existing weekday 5 p.m. Seattle automation is connected to this helper. Check errors are not evidence that school or glucose data is clear.

## Validation

```sh
npm test
npm run check
```

Tests use synthetic data; they do not need real school, glucose, or login data. Build and test before rebuilding a trusted helper: a new binary can cause a fresh Keychain approval prompt.
