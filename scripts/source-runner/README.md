# Source runner for the AWS Oregon pilot

The runner uses ordinary Google Chrome on Linux and reuses the Source
sign-in guard, student verification, reader, and version 1 observation
contract. It makes one sign-in, reads every child that has a Source
mapping, posts the results to the Worker, and exits. Nothing calls into
the instance. Schoology continues to use Cloudflare Browser Run.

## Settings

| Setting | Purpose |
| --- | --- |
| `SOURCE_CHILD_CONFIG` | Path to a private child mapping in the existing `children.json` format. |
| `SOURCE_USERNAME`, `SOURCE_PASSWORD` | The Source parent credentials. |
| `SOURCE_INGEST_URL` | The Worker's HTTPS URL ending in `/v1/ingest/source`. |
| `SOURCE_INGEST_TOKEN` | A random 32-byte token as 64 lowercase hex characters, shared with the Worker. |
| `SOURCE_STATE_DIR` | Optional. Where the runner records its last attempt. |
| `SOURCE_MIN_INTERVAL_MINUTES` | Optional. Minimum time between sign-ins. Default 360, floor 60. |

Run `node scripts/source-runner/run.js` as an unprivileged account. It
prints one JSON line with a status and each child's outcome. It prints
no student records.

## Sign-in limits

- The runner confirms the real login form before credentials reach the
  page. A firewall rejection is reported as `portal_request_rejected`
  and no sign-in is attempted.
- A second run inside the interval does nothing and reports `too_soon`.
- Two sign-in failures in a row hold the runner. A rejected credential
  request holds it at once. A held runner reports
  `held_after_sign_in_failure` on each run and does not sign in.
- A hold clears when the stored credentials change. An operator can
  also run the command once with `--clear-hold`.

Each child's result is independent. A child that cannot be verified is
reported as unavailable and the others are still stored. An unavailable
assignment page stays `null` in the observation.

## What the Worker receives

One `POST` per run with a run ID, the attempt time, and one result per
child. A result is either `ok` with an observation or `unavailable` with
a reason code. The Worker accepts only configured child IDs, stores each
result as its own row, and ignores a repeated run ID. See the
[Worker](../../worker/README.md) and the
[AWS deployment](../../deploy/aws/README.md).

The runner and the Worker handler are tested together against the real
database schema. The deployed Worker, the instance service and the
schedule are still to be verified live.

## Local credentials

For one-off checks on macOS, keep the dotenv file at
`~/Library/Application Support/SeattleSourceChecker/source.env`
with mode `0600`. Set `SOURCE_USERNAME` and `SOURCE_PASSWORD` there
using a local editor. Quote a value containing `#` or leading or
trailing spaces. The file is plaintext and lives outside the checkout.
Delete it when the hosted runner is in service. The Mac checker's
existing Keychain configuration continues to serve its normal
scheduled checks.
