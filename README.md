# Seattle Source checker

Private, local checks for a parent’s SPS Source, Sugarmate, and Schoology accounts, with macOS Keychain sign-in. Passwords are entered into a native secure dialog, stored in login Keychain, and passed through a private pipe to a fixed local browser worker only when a session needs reauthentication. There is no secret-export command. CLI output contains status or the requested school/glucose summary, never credentials.

## Setup

Requires macOS, Xcode command-line tools (or Xcode), Node.js 22+, and installed Google Chrome.

```sh
npm ci
npm run build
npm run setup:keychain
```

Enter the Source parent username/password, then the Sugarmate email/password in the two local macOS dialogs. Do not enter passwords into the terminal or chat. Keychain may request approval for the signed helper. Approving persistent access to these two items allows unattended re-login while login Keychain is unlocked. macOS can request approval again after rebuilding/signing the helper.

This creates **new, scoped Keychain items**. It does not read existing Apple Passwords/1Password entries or change their settings. The helper is signed locally (ad hoc); it is not notarized or a sandboxed app. The native helper uses the macOS login-Keychain ACL API, which Apple marks deprecated but still supports for this desktop use case. Credential and session protection is within your macOS user account; malicious code already running as your user could modify this project. Keep the repository and its dependencies under your control.

To add Schoology separately, run `npm run setup:keychain -- schoology` and enter the **parent account email** and password locally. The default setup still covers only Source and Sugarmate.

## Commands

```sh
./bin/checker status source
./bin/checker status sugarmate
./bin/checker status schoology
./bin/checker login source
./bin/checker login sugarmate
./bin/checker login schoology
./bin/checker check source
./bin/checker check schoology
./bin/checker check sugarmate 2026-11-05
```

`status` checks whether the scoped Keychain entry exists.
`check source` selects the configured child and returns published grades,
active missing flags, attendance and tardies. An unavailable assignment
table is marked unavailable.

`check schoology` verifies the configured child banner and reads the visible
parent summary. Details such as teacher feedback and full submission
history can require a separate read in normal Chrome.

## Child configuration

The checker reads student mappings from a private local
`children.json` file in
`~/Library/Application Support/SeattleSourceChecker/`. Keep it local and
set its permissions to `600`. Use `default-child` as the ID for an existing
Schoology profile. This example uses synthetic children.

```json
{
  "defaultChild": "alex-one",
  "children": [
    {
      "id": "alex-one",
      "displayName": "Alex One",
      "providers": {
        "source": {
          "tabLabel": "Alex",
          "tabHref": "/guardian/home.html?student=1",
          "studentHeading": "One, Alex",
          "term": "2026-S1"
        },
        "schoology": { "banner": "You are viewing as Alex One" }
      }
    },
    {
      "id": "alex-two",
      "displayName": "Alex Two",
      "providers": {
        "source": {
          "tabLabel": "Alex",
          "tabHref": "/guardian/home.html?student=2",
          "studentHeading": "Two, Alex",
          "term": "2026-S1"
        },
        "schoology": { "banner": "You are viewing as Alex Two" }
      }
    }
  ]
}
```

Copy actual labels and heading text from your guardian view. For duplicate
Source tab names, set each `tabHref` to the verified link path and query.
Omit it for a unique tab. Each provider heading or banner must be unique
among configured children. Add only providers linked to the guardian
account. The optional Source `term` is an operator-verified comparison
scope. Review it at term rollover. An unknown or different term leaves the
portable comparison unavailable.

Existing commands use `defaultChild`. Keep that value set to the child your
scheduled report is for. After the normal `npm run build`, select another
child explicitly with:

```sh
./bin/checker check source --child alex-two
./bin/checker login schoology --child alex-two
./bin/checker check schoology --child alex-two
```

During Schoology login, select the child in the opened Chrome window.
Each additional child gets a dedicated Schoology profile. If the portal
resets selection, the check requests interactive selection again.
Source selects the configured link on each check. Both portals verify
the selected child before extraction. Existing guardian credentials
continue to use the same per-service Keychain entries.

## Portable report model

School checks retain the existing `report` object and add a versioned
`observation`. The observation carries child ID, provider, check time,
coverage and assignment evidence. To build the portable report model,
send a JSON object containing `childId`, `cutoff` (an ISO timestamp at or
after collection), and `source` and/or `schoology` observations to
`node src/report-cli.js` on stdin. Optionally supply `timezone` and
a previous Friday Source observation as `baseline`. The result separates
Source missing flags, Schoology submission receipts, upcoming deadlines
and uncertain overdue items. A cleared missing flag requires affirmative
evidence from the same assignment row.

The existing Codex workflow still composes the Friday PDF and uses its
existing comparison history. The portable model is available for the
hosted runner and for local verification.

Schoology passwords are sent only to `https://app.schoology.com/login`. Only direct parent email/password login is automated. District SSO, MFA, CAPTCHA, and unexpected permissions remain interactive. No session cookies or tokens are exported from normal Chrome, no internal API requests are replayed, and no App Center registration or API consumer key is required for this browser implementation. Private Chrome profiles still contain sensitive session cookies and must remain protected.

The legacy Sugarmate check reads `sugarmate.json` from the same private
directory. Set `feedLabel` to the verified feed label and `studentName` to
the student it belongs to. Keep this file outside the repository. The
checker verifies the label and Dexcom attribution before reading data.

`check` runs headlessly; `login` opens Chrome and waits up to three minutes for you to complete any account setup, MFA, or consent yourself. Both use separate private profiles under `~/Library/Application Support/SeattleSourceChecker/` (directory mode 700). Cookies are sensitive session credentials; profiles stay outside the repository. Neither Chrome’s normal profile nor its debug port is used. The worker does not capture screenshots, network traces, videos, console logs, or password-containing exception messages. Schoology static dashboard assets may be read from its own asset CDN; password writes are still restricted to its login endpoint. Source credentials are restricted to its exact HTTPS origin; Sugarmate credential requests are restricted to its observed HTTPS OAuth token endpoint. Sugarmate’s country selection is set to US for this Seattle-based workflow.

## Weekday automation

The existing Codex weekday automation should call the absolute project command `bin/checker check source` first, use the latest successful chat result as its comparison baseline, then call `bin/checker check sugarmate YYYY-MM-DD ...` for new/changed absence dates and `bin/checker check schoology` for the parent summary. Use the existing signed-in normal Chrome session for relevant Schoology assignment details not included in the summary. These commands retrieve credentials internally; never call the macOS `security` CLI to print credentials. No automated email or school-record changes are implemented.

If the helper returns `setup_required`, run setup locally. For `keychain_access_required`, unlock/approve the scoped entry locally. `sign_in_needs_attention` means the login was not verified (invalid credentials, MFA, CAPTCHA, or a changed page); the checker does not bypass those challenges. `check_already_running` avoids overlapping access to a profile. If a process is force-killed its service `.lock` may need manual removal after verifying no checker process remains. `check_failed` is intentionally generic to avoid leaking browser data.

Source and Sugarmate scoped Keychain entries and live sign-ins were verified on November 6, 2026. Live Source extraction and a dated Sugarmate comparison also passed. The existing weekday 5 p.m. Seattle automation is connected to this helper. Schoology Keychain-backed reauthentication (not merely session reuse), Sample identity, the expanded four-item overdue list, two upcoming items, calendar and submitted/awaiting-grade outline were verified live later the same day. The weekday automation now calls all three services. Check errors are not evidence that school or glucose data is clear.

## Validation

```sh
npm test
npm run check
```

Tests use synthetic data; they do not need real school, glucose, or login data. Build and test before rebuilding a trusted helper: a new binary can cause a fresh Keychain approval prompt.
