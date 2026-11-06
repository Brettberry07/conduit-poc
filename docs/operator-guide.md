# API and worker operator guide

[Documentation index](README.md) · [Project overview](../README.md)

Local setup, credentials, queue semantics and worker recovery, consolidated from the original README. For registered GitHub development, use the [project/worktree runbook](PHASE_4_TESTING.md). For hosted setup, use the [deployment runbook](deployment.md). These instructions describe operator procedures, not the current state of any private installation. The package remains `conduit-poc`; the private database schema remains `orchestrator` to preserve migration compatibility.

## Supabase Auth account links

Apply the auth-users migration before enabling email sign-in. Use the existing private admin environment (`.env.admin.local` / `ADMIN_DATABASE_URL`) with `adminDatabase()`; the runtime can only SELECT mappings. The existing `conduit_key_admin` group gains SELECT/INSERT/DELETE on mappings, with an administrator RLS policy; UPDATE is not granted. Ordinary Auth accounts cannot create or modify mappings. Link only a verified Auth user UUID to the intended principal, never by matching an email address. A new account has no job access until explicitly linked.

```sh
npm exec -- tsx scripts/user.ts link --auth-user-id UUID --principal PRINCIPAL
npm exec -- tsx scripts/user.ts list
npm exec -- tsx scripts/user.ts unlink --auth-user-id UUID
```

The CLI uses the same principal validation as key administration, refuses duplicate UUIDs, and lists mapping metadata only. To change a mapping, explicitly unlink first. The requested `npm run user -- ...` alias would require changing package.json; because package files must remain unchanged, use the direct commands above.

**OPERATOR CHECKS (not verified facts):**

- Check whether email/password sign-ups are enabled in Supabase Auth.
- Check whether email confirmation is required and configure its delivery and URLs.
- Set both publishable `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the hosting environment before building; Next.js inlines public client values at build time. The server derives its public JWKS URL and issuer from that URL. Use ES256 signing keys. If the URL is unset, JWT authentication is disabled.

## Local setup and full verification

Use Node.js **24.x**, the Vercel runtime target, and npm:

```sh
npm ci
npm test
npm run build
npm run typecheck
```

The full suite (outside the offline worker sandbox) provisions disposable loopback PostgreSQL clusters, apply the actual migrations, exercise the real Next.js HTTP API and run a separate worker process. They do not load your real admin file, contact cloud databases, or change the earlier POC database. No Docker is required for these tests; do not run them as root. The embedded PostgreSQL binary is a development dependency only.

For interactive local development, `npm run db:local` starts a **separate** Conduit database on port 54433 in ignored `.local-pg-conduit/`, applies migrations, and writes `.env.admin.local`. It leaves the earlier port-54432 database and its data alone. It refuses to overwrite a different admin configuration. Keep that process open, then run once:

```sh
npm run db:runtime
```

That provisions the restricted runtime database login and writes `.secrets/runtime-database.env`. Preserve any existing `.env.local` privately before replacing it with this new runtime configuration. Do not overwrite an existing hosted configuration accidentally.

```sh
# If .env.local exists, first copy it to a unique private backup in .secrets/.
cp .secrets/runtime-database.env .env.local
chmod 600 .env.local
npm run dev
```

Generate local credentials using the same CLI below. In another terminal start the worker with `CONDUIT_API_URL=http://127.0.0.1:3000`. If the earlier web server occupies port 3000, stop it or pass `--port 3001` to `npm run dev -- --port 3001` and use that origin for the worker/probe. Ctrl-C stops the local database gracefully. Never delete the data directory or a live worker's lock to resolve a startup conflict.

## Persistent API keys

Key management runs **locally with the key-management-only database login** using `.env.admin.local`. The local database bootstrap initially writes an administrator connection; hosted operators should use the separate restricted key-administrator login described in the deployment runbook. It does not run in Vercel or through an HTTP endpoint. The `.env.admin.example` template describes its configuration. A restricted runtime connection cannot read or administer the key table.

Create a default 30-day Instinct key, delivering the plaintext once into a private local file:

```sh
npm run key -- create --type instinct --principal instinct --name "Instinct primary" --out .secrets/instinct.json
```

Create a separate worker key:

```sh
npm run key -- create --type worker --principal mac-worker --name "MacBook worker" --out .secrets/worker.json
```

Create a read-only viewer key for `/app/board`, `/app/active`, and `/app/needs-you`, using the same principal as the job owner:

```sh
npm run key -- create --type viewer --principal ID --name NAME
```

Viewer keys have exactly `jobs:read` and role `submitter`. They permit GET requests for jobs, workers, job detail, revisions, executions, changes, diff, and publication. They cannot create, revise, claim, or update jobs. Paste the key into Connect; the GUI holds it in React memory only and loses it on refresh, disconnect, or closing the page.

To display a key **once in an interactive terminal instead**, omit `--out`. Do not capture that terminal in chat, screenshots, recordings or shared logs. Noninteractive creation requires `--out`; files use mode 600 and are never overwritten. The database stores only a SHA-256 hash of 256 random bits, plus an identification prefix. Full credentials start with `cnd_live_`. There is no API or CLI operation to retrieve their plaintext later.

Expiration defaults to 30 days; use `--days 60` (integer 1–3650) to customize it. Keys survive worker/API restarts and deployments, until expiration or explicit revocation. There is no hourly token refresh.

```sh
npm run key -- list
npm run key -- revoke KEY_UUID
```

Listing returns metadata, scopes, prefix, expiration, revocation and last-used timestamps; it returns neither plaintext nor hashes. Revoke uses a unique key ID, so overlapping rotation can keep a replacement key valid. Principals identify job owners/workers independently of key IDs: rotate with the **same principal** to retain access and recovery ownership. A different principal creates a separate permission boundary.

| Credential type     | Scopes                                    |
| ------------------- | ----------------------------------------- |
| Instinct (new keys) | `jobs:create`, `jobs:read`, `jobs:revise` |
| Local worker        | `jobs:claim`, `jobs:update`               |
| Viewer              | `jobs:read`                               |

Workers receive the task in the claim response and need no general `jobs:read` permission. Every protected request validates the hash, expiry, revocation and required scope using the database. Valid authentication updates `last_used_at`; there is no stale in-memory authorization cache. In-flight requests that already authenticated may finish during revocation; subsequent requests are denied.

See [Instinct setup and rotation](instinct.md). Legacy unprefixed temporary keys are revoked by the new migration and rejected by the new API. Their metadata is retained; existing job rows and identities are preserved when upgrading a database in place.

## Worker

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
WORKER_KEY_FILE=.secrets/worker-hosted.json \
WORKER_STATE_DIR=.worker/hosted-mac-worker \
npm run worker
```

`ORCHESTRATOR_URL` remains a compatibility alias; `CONDUIT_API_URL` takes precedence. Use the stable Vercel project domain, not a disposable preview URL. The worker needs only its API URL, private key file and local state directory—**no database connection or Supabase administrative key**. `.env.worker.example` is a template; the worker reads the process environment, not `.env.local`.

Use a new state directory for the new hosted queue and one worker identity per running instance. The worker binds state to its API origin to prevent reusing recovery tokens on a different host. Keep that directory across restarts. Worker logs are JSON lines with worker/job IDs and progress, never bearer keys or claim tokens. Keep your Mac awake and the worker running during the POC.

The worker executes up to `CONDUIT_MAX_AGENTS` jobs concurrently, one job per agent, across all task types. The default is `4`; only integers `1`–`4` are accepted. Non-numeric, fractional, and out-of-range values fail startup rather than being clamped. The server independently caps each owner (`submitter_id`) at 4 running jobs with live leases across all worker processes and identities; other owners retain their own slots. This bounds leased jobs, while each worker's agent limit controls its physical execution concurrency. Expired leases do not count toward the cap, and any abandoned local processes remain governed by existing lease fencing and recovery. Terminal reports free a slot immediately. Jobs with unresolved dependencies remain `waiting_dependencies` and do not consume a slot: every prerequisite's pull request must be merged before the job can be claimed. Completion without a merge is not done. A failed or blocked prerequisite, or a pull request closed unmerged, blocks dependent jobs. GitHub reconciliation runs about every 30 seconds once per worker process.

For simulation jobs, the worker polls every two seconds, reports progress during five bounded simulation steps, and uses 10-second HTTP timeouts. Network failures stop work and retry with bounded exponential backoff (1–10 seconds). Each job's `journal-<job_id>.json` persists its claim before work and outcome before reporting. Startup resumes all recovered journals within the agent limit, including a legacy `journal.json`; unreadable journals stop the worker without discarding recovery state. A restarted worker renews a still-valid claim, retries a saved outcome, or drops a stale claim after HTTP 409. HTTP 401/403 stops the worker so you can replace/reconfigure its credential.

Ctrl-C/SIGTERM stops new claims, signals all in-flight agents to stop cleanly, preserves their worktrees and journals, and removes the process lock after they stop. After a crash/SIGKILL, verify the recorded lock PID is no longer running before removing **only** `.worker/<state>/lock`; keep every `journal-<job_id>.json`, any legacy `journal.json`, and `origin`. Do not run two workers with the same identity/state.

## API contract

Every `/api/*` operation requires `Authorization: Bearer <cnd_live_…>`. Requests and JSON responses keep the original shape. No automatic redirects are followed by the worker/probe. Use HTTPS except for loopback development.

| Endpoint                                         | Required scope | Behavior                                             |
| ------------------------------------------------ | -------------- | ---------------------------------------------------- |
| `POST /api/jobs`                                 | `jobs:create`  | Create; UUID `Idempotency-Key` header required       |
| `GET /api/jobs?limit=100&before=<ISO timestamp>` | `jobs:read`    | Own jobs only; newest first, maximum 100             |
| `GET /api/jobs/:id`                              | `jobs:read`    | Own job status/result/error/timestamps               |
| `GET /api/workers`                               | `jobs:read`    | Existing worker availability endpoint; no UI         |
| `POST /api/heartbeat`                            | `jobs:update`  | Update this worker identity's last-seen timestamp    |
| `POST /api/claim`                                | `jobs:claim`   | Atomic claim or `{ "job": null }`                    |
| `POST /api/jobs/:id/report`                      | `jobs:update`  | Progress/completion/failure with current claim token |

Create body:

```json
{
  "title": "Connectivity test",
  "description": "Optional",
  "task": "simulate-development"
}
```

`simulate-development` and `simulate-failure` remain supported. Phase 3 adds `codex_task` for its fixed sandbox, and Phase 4 adds `development` for registered project IDs (see the phase runbooks). Unknown fields are rejected. Request bodies are capped at 32 KiB; title at 200 characters, description/error at 4000. No arbitrary command or shell task can be submitted.

Job responses use `{ "job": ... }`; lists use `{ "jobs": [...] }`. Submitter responses never contain claim tokens. Legacy jobs retain `queued`, `running`, `completed`, `failed`. Phase 4 adds `waiting_dependencies`, `blocked`, and a running `phase` field. Errors remain 400 invalid input, 401 missing/invalid/expired/revoked key, 403 missing scope, 404 missing/unowned job/route, 409 stale claim or idempotency conflict, 500 sanitized internal error. Key-management paths do not exist.

Use the same UUID and identical body to retry an ambiguous creation response. Timestamp pagination can skip exact timestamp ties; integrations should retain job IDs and retrieve results individually.

## Queue guarantees

The existing lease/token fencing is preserved; Phase 4 adds dependency and branch coordination. `FOR UPDATE SKIP LOCKED` plus a single update atomically assigns a random per-attempt token, worker identity, 30-second lease and incremented attempt count. Progress extends the lease using database time. All updates are fenced by worker ID, token and unexpired running lease. Repeated terminal acknowledgments preserve the first result. Different workers cannot hold the same unexpired claim.

Execution remains **at least once**, not exactly once. A paused process may resume after another worker reclaims its expired lease; stale tokens cannot overwrite the new attempt. Simulations have no external effects. After three abandoned attempts a job becomes failed on the next claim poll; there is no background sweeper. Worker availability is observational (heartbeat within 15 seconds), not a reservation.

## Database and deployment

- `20261104221612_job_queue.sql`: original private schema and queue.
- `20261104232105_persistent_api_keys.sql`: upgrade existing key table, retain jobs, revoke legacy credentials.
- `20261104232106_runtime_permissions.sql`: restricted server group, job/worker RLS policies and narrow private key-authentication function.
- `20261104233846_key_administrator_role.sql`: separate key-administrator role with API-key permissions and no job/runtime access.
- `20261105015635_codex_tasks.sql`: Phase 3 sandbox task inputs.
- `20261105062426_persistent_projects.sql`: Phase 4 registry, development/revision coordination, execution history, diff artifacts and revision scope.

The runtime cannot access the key table directly. Its only credential operation is a private `SECURITY DEFINER` function that validates a hash and updates `last_used_at`; it has an empty search path, explicit runtime-only execution grant and no dynamic SQL. No `anon`/`authenticated` grants are added. All key-management and migration access stays with the local administrator.

Supabase transaction pooling suits the stateless API; admin migrations use a session/direct connection. No named prepared statements or session-dependent runtime SQL are used. The server pool is capped at three connections per instance and uses Vercel's `attachDatabasePool`. Remote database connections require verified TLS; URL options that could override TLS configuration are rejected. Only a server-side `DATABASE_URL` is required—there is no browser Supabase client or service-role API key.

See [the deployment runbook](deployment.md), [acceptance tests](manual-test.md), and [verification evidence](verification.md).

## Connectivity and credential checks

- `GET /health` is public. HTTP 200 with `status: "ok"` and `database: "ok"` means the API can query the jobs schema in Supabase. HTTP 503 means readiness failed. This does not promise a worker is online.
- `GET /auth-check` uses `Authorization: Bearer <key>`. HTTP 200 with `authenticated: true` and `instinct_access: true` verifies both Instinct scopes (`jobs:create`, `jobs:read`). HTTP 401 means missing/invalid/expired/revoked credentials. HTTP 403 with `authenticated: true` means a valid key lacks Instinct permissions (including a worker key). HTTP 503 means the service could not validate the credential. Responses include principal/scopes/permission booleans, never plaintext keys or hashes.

Both checks disable caching. Use `/api/workers` with the Instinct key to check worker availability, then POST a simulation and retrieve its result to prove the full loop.

## Phase 3: real Codex execution

See [PHASE_3_TESTING.md](PHASE_3_TESTING.md) for isolated TypeScript tasks, local Codex login, setup, smoke probes, failure handling, and current verification evidence. Simulation jobs remain supported.

## Phase 4: registered GitHub projects and persistent worktrees

See [PHASE_4_TESTING.md](PHASE_4_TESTING.md) for the additive migration, local project registration, default `strict_bot` and explicit `prototype` modes (existing gh login or a classic/fine-grained PAT in prototype), credential setup, worktree execution, review/diff endpoints, same-PR revisions, recovery commands and opt-in live demonstration. Existing simulation and Phase 3 sandbox contracts remain supported. Phase 4 introduces `jobs:revise` for newly issued Instinct keys; existing keys retain their original scopes. Installation requires the documented manual setup. The later authorized rollout and live GitHub/Codex proof are recorded as historical evidence in [the implementation handoff](PHASE_4_IMPLEMENTATION.md); they do not establish current readiness.
