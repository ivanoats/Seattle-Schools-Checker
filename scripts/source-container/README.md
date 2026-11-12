# Cloudflare Containers probe for The Source

This temporary Worker starts one Linux container with standard Google
Chrome and runs the existing public Source sign-in probe. The probe uses
no parent account and returns only its classification, HTTP status, check
time, and browser metadata. It does not expose a general browsing endpoint.

## Build and validate locally

With Docker running, use the Node.js version required by the pinned
Cloudflare CLI. Run from this directory:

```sh
npm ci
npm run validate
```

This builds the Worker and Linux amd64 image without uploading them.
The repository’s normal checker does not need these development tools.

## Run on Cloudflare

Cloudflare Containers requires Workers Paid. After confirming the target
account and approving the temporary deployment, generate a random token
of at least 32 characters. Store it as the `PROBE_TOKEN` Worker secret
using a temporary private file outside the repository.

```sh
npx --no-install cf deploy --secrets-file /path/to/private-probe-secrets.json
```

Send one `POST /probe` to the deployed Worker with
`Authorization: Bearer <probe token>`. Without the token the Worker returns
404. Keep the token local. Record the result, then remove the temporary
Worker and Container application. The container goes idle after one minute.

| Result | Meaning |
| --- | --- |
| `login_form_reached` | Stock Chrome reached the actual Source login form from this container. Continue with an authorized sign-in test. |
| `portal_request_rejected` | The portal returned a firewall rejection, even if the HTTP status is 200. |
| `portal_session_not_established` | The portal showed its access-session error. |
| `login_page_unverified` | Navigation did not produce a verified login form. |
| `container_start_timeout`, `container_probe_failed`, or `browser_or_navigation_failed` | Investigate the runtime or network before drawing a conclusion about portal access. |
