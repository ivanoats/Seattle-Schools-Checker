# Source runner for the AWS Oregon pilot

The Node runner uses ordinary Google Chrome on Linux and reuses the
Source sign-in guard, student verification, reader, and version 1
observation contract. The [Cloudflare client](../../src/cloudflare/source-client.js)
is ready to import into an authorized Worker job. Schoology continues
to use Cloudflare Browser Run.

## Run the origin

Install the repo dependencies and Google Chrome on the EC2 host.
Provide these settings through the process manager:

| Setting | Purpose |
| --- | --- |
| `SOURCE_CHILD_CONFIG` | Path to a private child mapping in the existing `children.json` format. This pilot serves only its default child. |
| `SOURCE_USERNAME`, `SOURCE_PASSWORD` | The Source parent credentials, provided to the AWS process by its secret configuration. |
| `SOURCE_RUNNER_TOKEN` | A randomly generated 32-byte token encoded as 64 lowercase hex characters. |

Run `node scripts/source-runner/server.js` as an unprivileged account.
The origin listens on `127.0.0.1:8080`. It accepts one check at a time
at `POST /v1/source/check`, with the origin token and a body containing
only `version: 1` and the configured opaque `childId`. The response
carries a versioned observation or an error code. An unavailable
assignment page stays `null` in the observation.

## Connect the Worker

1. Route a named Cloudflare Tunnel to the EC2 loopback origin. Protect
   the hostname with a Cloudflare Access Service Auth policy for the
   Worker’s service token. Keep the EC2 inbound security group closed.
2. Configure `SOURCE_RUNNER_URL` with the HTTPS check URL ending in
   `/v1/source/check`. Supply `SOURCE_RUNNER_TOKEN`,
   `SOURCE_ACCESS_CLIENT_ID`, and `SOURCE_ACCESS_CLIENT_SECRET` as
   Worker secrets. The Source password is held by the AWS runner.
3. Call `fetchSourceObservation(env, childId)` only after the Worker
   has authorized the job and resolved the child. Treat an unavailable
   result as a provider failure and preserve the last verified snapshot.
   Keep this route out of the browser-facing API.
4. Before enabling a schedule, verify that an unauthenticated request
   is denied and run one authorized end-to-end check. Confirm the
   target child and compare the observation with the Mac.

The loopback contract is tested locally. The tunnel, Access application,
AWS service process, Worker deployment, and scheduled dispatch are pending.
The live Chrome checks used the separate interactive probe.

[Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) ·
[Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## Local credentials

For one-off checks on macOS, keep the dotenv file at
`~/Library/Application Support/SeattleSourceChecker/source.env`
with mode `0600`. Set `SOURCE_USERNAME` and `SOURCE_PASSWORD` there
using a local editor. Quote a value containing `#` or leading or
trailing spaces. The file is plaintext and lives outside the checkout.
The Mac checker's existing Keychain configuration continues to serve
its normal scheduled checks.
