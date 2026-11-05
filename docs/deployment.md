# Supabase + Vercel deployment runbook

**Current deployment (Phase 4 enabled November 5, 2026):**

- API: [https://conduit-poc.vercel.app](https://conduit-poc.vercel.app).
- Vercel project: `prj_hJEeIrQwueIgVsyQcBkQDmg0ulDL`; production deployment `dpl_AKTULmzcVJczkWGb8YkkF64chNyr`, commit `406557e443cd1175963b9434b6ecef3da2361eb4`, Node 24.
- Supabase: [conduit-poc](https://supabase.com/dashboard/project/noftwqvntanjjgdchmmy), project ref `noftwqvntanjjgdchmmy`. The Phase 4 migration and matching local-runner checksum are installed. New tables have RLS enabled; the runtime can read projects but cannot register them.
- Registered project: `888e3eae-a7db-4d55-959f-34e738466191`, `Brettberry07/conduit-poc`.
- Mac worker: running with explicit local prototype configuration in `/Users/brettberry/.conduit/hosted`, existing `gh auth`, official Node 24 and the retained `.worker/hosted-mac-worker` journal.
- Phase 4 Instinct key delivery: `.secrets/instinct-phase4.json`, with `jobs:create`, `jobs:read`, `jobs:revise`, same `instinct` principal, expires December 5, 2026. The older `.secrets/instinct-hosted.json` remains active until replacement is verified in Instinct.
- Worker key delivery remains `.secrets/worker-hosted.json`. GitHub credentials stay local; none were added to Vercel or API payloads.

Verified: authenticated `/api/projects` returns 200 with the registered project; anonymous access returns 401; the new key retains historical job access and passes revision authorization; hosted readiness simulation `7988bf84-d652-430b-bcb9-920cb83a1512` completed on `mac-worker`. The actual GitHub/Codex draft-PR and same-PR revision proof ran through the local API earlier; Instinct's own hosted development test remains the external acceptance gate.

Use [the prepared Phase 4 prompt](instinct-phase4-test-prompt.md). Run `/Users/brettberry/.conduit/hosted/copy-instinct-key.sh` locally and paste the copied API key only into Instinct's secure secret field before sending that prompt. The worker now permits normal repository-wide source, test, documentation and configuration edits (`allowed_paths: ["*"]`, no administrator read-only source paths). Verification runs route-type generation, TypeScript checking and offline unit tests with existing dependencies. Use [the development handoff](instinct-development-prompt.md) for /info and subsequent tasks. Keep the Mac awake; no new auto-restart service was installed.

The authorized rollout used the authenticated Supabase connector for schema/registration and Vercel connector for deployment. No administrator password was reset, GitHub settings changed, automatic Git deployment configured, or new infrastructure created. The steps below describe a **new installation**; do not recreate this existing project's database roles/resources.

## 1. Finish local verification

Use Node 24.x, then run `npm ci`, `npm test`, `npm run build`, and `npm run typecheck`. Tests use disposable local PostgreSQL and a separate real worker process. The API is stateless; no queue or key state lives in Vercel process memory or its filesystem. Do not start a database or worker inside a Vercel function.

## 2. Create a dedicated Supabase POC project — after approval

Choose the organization, project name `conduit-poc`, plan and region. Place Vercel Functions near this database. Save the database admin password in a password manager. Do not send it through chat.

From the project's Connect panel, obtain its **session-pooler** PostgreSQL connection string (port 5432) for administration. Direct connections also work if your Mac has suitable IPv6/network access. Use only the new project's connection. The application does not use Supabase Auth or the Data API; keep the `orchestrator` and `conduit_meta` schemas out of exposed schemas and do not grant them to `anon` or `authenticated`.

For schema installation, privately create `.env.schema-admin.local` from `.env.schema-admin.example` (mode 600), setting:

```dotenv
ADMIN_DATABASE_URL=postgresql://postgres.PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres
DATABASE_SSL=true
```

Replace values locally. URL-encode the password. Remove `sslmode`/`sslcert`/`sslkey`/`sslrootcert` URL query parameters; the code sets verified TLS explicitly. If the project certificate requires its own CA, download the project's database CA certificate and put its PEM into `DATABASE_CA_PEM` (quoted multiline value) or use local `DATABASE_CA_FILE`. Do not use `rejectUnauthorized:false` or `sslmode=no-verify`.

Supabase explains [connection/pooler choices](https://supabase.com/docs/guides/database/connecting-to-postgres) and [database roles](https://supabase.com/docs/guides/database/postgres/roles). Review the current Connect settings rather than guessing hosts or usernames.

## 3. Apply versioned SQL only to that project — after approval

```sh
CONDUIT_ADMIN_ENV_FILE=.env.schema-admin.local npm run db:migrate -- --project-ref YOUR_20_CHARACTER_PROJECT_REF
```

The custom runner uses the administrator connection, verifies that its host/username matches the supplied project ref, and applies all four SQL files transactionally. It records filenames/checksums in private `conduit_meta.schema_migrations`, takes an advisory transaction lock and refuses edited applied migrations. Re-running is a no-op. The hosted installation used the Supabase migration connector to apply the initial schema and recorded matching checksums in this private table. Supabase also retains its connector migration history. For future local schema administration, use this runner with a separately configured schema-admin connection; it recognizes the applied checksums and will not replay the installed files. SQL files remain standard, versioned PostgreSQL migrations.

For an **existing original local POC schema only**, `--local --adopt-legacy` records the reviewed original schema as the baseline and applies the upgrades. Do not use adoption for a new hosted project. Adoption is explicit because the original schema was applied before migration tracking existed; it does not prove an arbitrary schema matches.

Verify the new project has `orchestrator.jobs`, `orchestrator.workers`, and `orchestrator.api_keys`. Check RLS is enabled on all three and run Supabase's security advisors. The only definer function is private `orchestrator.authenticate_api_key(text)`; public/client roles must not be able to execute it. It deliberately grants no public REST access.

A fresh hosted queue is empty. Existing local jobs are not replayed or moved automatically. If historical records are needed later, plan a separate offline export/import after stopping/draining workers; never copy active claim tokens into a live second queue.

## 4. Provision the restricted runtime database login

```sh
CONDUIT_ADMIN_ENV_FILE=.env.schema-admin.local npm run db:runtime
```

This administrator-only CLI creates `conduit_runtime` with login but no superuser, database creation, role creation or RLS-bypass rights, and grants only membership in `conduit_api`. It refuses an existing role or output file to avoid silently rotating a running deployment's password. It writes the connection to private `.secrets/runtime-database.env`, never stdout. For a Supabase pooler hostname it selects port **6543** and the username `conduit_runtime.PROJECT_REF` for the API.

Verify this custom-role connection works through your project's pooler before deployment. Run the local Next.js API against it if needed. Runtime must be able to process jobs and call the authentication function, while `SELECT/INSERT/UPDATE/DELETE` on the API-key table and access to migration history fail. This boundary is already checked against PostgreSQL in automated tests, but hosted pooler connectivity remains a deployment acceptance check.

The runtime login also gets role-level statement/lock/idle-transaction timeouts (10s/5s/15s). These work with transaction pooling; no session `SET` is required by API requests. See [Supabase timeout guidance](https://supabase.com/docs/guides/database/postgres/timeouts).

The installed deployment also has a separate `conduit_key_admin` login created from the fourth migration. Its random password was delivered only into private local `.env.admin.local`; its database permissions are limited to API-key management, while schema/runtime provisioning continues to require the full schema administrator. Neither database credential is a bearer API key.

The admin credential belongs only in your private local admin environment/password manager. **Do not configure it in Vercel, Instinct, the worker, a repository or an issue.** Only the restricted runtime credential goes to Vercel. Supabase service-role/publishable API keys are unnecessary for this implementation.

## 5. Generate separate 30-day keys

```sh
npm run key -- create --type instinct --principal instinct --name "Instinct primary" --out .secrets/instinct.json
npm run key -- create --type worker --principal mac-worker --name "MacBook worker" --out .secrets/worker.json
npm run key -- list
```

Use secure local files or a password manager for plaintext. These files are not deployed or committed. Key metadata/hashes live in the new Supabase project. See `instinct.md` for secure provisioning and rotation. There are no key-management HTTP endpoints.

## 6. Configure and deploy the dedicated Vercel project — after approval

Use the existing Next.js project; no rewrite or dashboard is required. Create/link a **new** Vercel project named `conduit-poc` in the chosen team. Source/root directory is this checkout. No GitHub integration or PR management is required; the Vercel CLI can deploy reviewed local source. Do not connect a Git provider merely to complete this POC.

Configure:

| Setting           | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| Framework         | Next.js                                                                       |
| Node.js           | 24.x                                                                          |
| Install command   | `npm ci`                                                                      |
| Build command     | `npm run build`                                                               |
| Output directory  | Next.js default (do not override)                                             |
| Function region   | Near the Supabase project                                                     |
| API duration      | 30 seconds, set in the route                                                  |
| `DATABASE_URL`    | Restricted transaction-pooler connection from `.secrets/runtime-database.env` |
| `DATABASE_SSL`    | `true`                                                                        |
| `DATABASE_CA_PEM` | Project CA PEM if required; do not use a Mac-only certificate path on Vercel  |

Store the database URL as a Vercel **Secret** environment value. Scope it only to this approved POC environment. Do not give arbitrary preview deployments access to that database. Never prefix credentials with `NEXT_PUBLIC_`. Never upload `.env.admin.local`, `.secrets/`, `.local-pg*/`, `.worker/`, or logs. `.vercelignore` excludes them from CLI uploads; `.gitignore` excludes secrets from source control. The Vercel server does not need Instinct/worker plaintext keys, `ADMIN_DATABASE_URL`, or a Supabase service-role key.

After approving the target team/project and configuring variables, deploy with the Vercel CLI or dashboard. A CLI production-domain deployment is `vercel deploy --prod` from the **verified new POC project**. “Production” here is Vercel's stable-domain environment for this POC, not a full production Conduit release. Do not run this command until deployment is approved. Do not add a CI workflow or auto-deployment trigger.

For machine HTTP access, use the stable project `https://<project>.vercel.app` domain. Configure Deployment Protection for this dedicated POC so that domain accepts machine requests without a Vercel login page; retain the application's bearer authentication. Do not weaken protection on unrelated projects. An anonymous `GET /api/jobs` must return the application's JSON 401, not an HTML sign-in page or redirect. If your team requires deployment protection, arrange an approved machine-access mechanism before attempting the acceptance test.

Vercel documents [Next.js deployments](https://vercel.com/docs/frameworks/full-stack/nextjs), [environment variables](https://vercel.com/docs/environment-variables), [pool lifecycle management](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package), and [Deployment Protection](https://vercel.com/docs/deployment-protection). The API uses Supabase's pooler and `attachDatabasePool` to release idle clients before function suspension.

## 7. Connect the Mac worker to Vercel

Stop or leave isolated the old local-queue worker; do not reuse its journal for hosted jobs. Start the new worker:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
WORKER_KEY_FILE=.secrets/worker.json \
WORKER_STATE_DIR=.worker/hosted-mac-worker \
npm run worker
```

Only HTTPS API access is needed. Keep the Mac awake. No local PostgreSQL, Cloudflare Tunnel or direct worker-to-Supabase connection is involved.

## 8. Verify hosted acceptance before cutover

First verify reachability without credentials:

```sh
curl -i https://YOUR-PROJECT.vercel.app/api/jobs
```

Expect JSON **401**. Then, with the worker running, use the secure file-based probe:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
SUBMITTER_KEY_FILE=.secrets/instinct.json \
npm run smoke
```

The probe prints a request UUID before submission, submits twice using the same body/UUID to verify idempotency, and polls for completion for about 60 seconds. It writes an ignored receipt containing the UUID, origin and job ID, never the token. If interrupted, retry with `REQUEST_ID=<printed-UUID>` and the same endpoint. An HTTP error is reported by status only. The probe confirms remote API/worker behavior from your Mac; it does **not** prove Instinct access.

Privately inspect the job row in the new Supabase project to confirm its completed status, result, worker and timestamps. Then configure Instinct with the Vercel domain and saved Instinct key, and execute the exact POST/GET acceptance procedure in `instinct.md`. Retest temporary network failure/restart behavior using `manual-test.md`.

Only after the **Instinct → Vercel → Supabase → local worker → Supabase → Instinct** loop passes should you stop the old Cloudflare tunnel/local API/database and revoke old credentials. Preserve the old local database as rollback evidence. Stop old local services gracefully; do not delete their data.

## Rollback and rotation

Before hosted acceptance, the old POC deployment/database can remain isolated and unchanged. The new code rejects legacy unprefixed keys; rolling back needs both the original code revision and its original database/auth configuration. Do not point old code at the upgraded key table or blindly reverse schema changes. Prefer keeping the dedicated hosted POC isolated, fixing forward and redeploying. A Vercel rollback does not undo database migrations.

API-key rotation needs no deployment: issue a replacement with the same principal, update the consumer securely, test it, revoke the old key ID. Database password rotation is different: coordinate a new runtime database password and Vercel Secret, redeploy, verify and remove the old credential. `db:runtime` intentionally will not perform that rotation implicitly.
