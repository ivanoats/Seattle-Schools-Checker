# Checker Worker

The Worker receives Source results from the hosted runner and stores
them in D1. It has two routes. Both answer 404 without the right token.

| Route | Token | Purpose |
| --- | --- | --- |
| `POST /v1/ingest/source` | `INGEST_TOKEN` | Stores one run's results. Used only by the Source runner. |
| `GET /v1/checks/latest` | `STATUS_TOKEN` | Lists, per child and provider, the last attempt, its status and reason, and the last verified time. Returns no student records. |

Every check is its own row. A failed check never replaces a verified
observation. A repeated run ID stores nothing new. The handler is in
[`src/cloudflare/`](../src/cloudflare/ingest.js) and the schema is in
[`migrations/`](migrations/0001_provider_checks.sql).

## Validate

```sh
npm ci
npm run validate
```

This builds the Worker without uploading it.

## Deploy

1. Create the database and apply the schema. Use the database ID that
   `create` prints, and set the same ID on the `DB` binding in
   `cloudflare.config.ts`.

   ```sh
   npx --no-install cf d1 create --name seattle-schools-checker
   npx --no-install cf d1 migrations apply <database-id>
   ```

2. Write the secrets to a private file outside the repository, then
   deploy with it and delete the file.

   | Secret | Value |
   | --- | --- |
   | `FAMILY_ID` | An opaque ID for the pilot household, such as `pilot-family`. |
   | `CHILD_IDS` | The child IDs from `children.json`, separated by commas. |
   | `INGEST_TOKEN` | `openssl rand -hex 32`. Also given to the Source runner. |
   | `STATUS_TOKEN` | A second `openssl rand -hex 32`. Kept by the operator. |

   ```sh
   npx --no-install cf deploy --secrets-file /path/to/private-secrets.env
   ```

3. Check that `GET /v1/checks/latest` returns 404 without a token and
   an empty list with the status token.

The schedule and Schoology runner are not part of this Worker yet.
The `/app` dashboard and `/api/pilot/*` invitation/membership routes require
Access configuration, migration 0002 and trusted provider discovery before
another parent can onboard. School password entry remains disabled. See the
[pilot status and deployment gates](../docs/architecture/web-pilot-status.md).
Install root dependencies as well as Worker dependencies before building.
