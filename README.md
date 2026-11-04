# Orchestrator POC

A standalone Next.js / TypeScript API and dashboard, Supabase PostgreSQL queue, and macOS Node.js worker. The worker runs **only two predefined simulations**. There is no Codex, GitHub execution, PR management, simulator automation, or production deployment.

## Run locally

Requires Node.js 22+ and npm. From this directory:

```sh
npm ci
```

Choose **one** database setup:

**A. Local Supabase (intended stack).** Start Docker Desktop, then use the pinned CLI version used here (2.105.0):

```sh
supabase start
supabase migration up --local
cp .env.example .env.local
chmod 600 .env.local
```

The generated `supabase/config.toml` identifies this standalone local project as `orchestrator-poc`. The example URL uses its default local PostgreSQL port 54322. Do not link this project to StillOn or run unscoped hosted migration commands. The migration creates only the private `orchestrator` schema. Existing public tables are untouched. To shut down this local Supabase stack, use `supabase stop` from this directory.

**B. Docker-free development fallback.** This starts a real, isolated PostgreSQL server on loopback port 54432, applies this project's migration, and writes a mode-600 `.env.local` without printing its random password:

```sh
npm run db:local
```

Keep it running in its own terminal. It refuses to overwrite a different `.env.local`; choose A or B before configuring the environment. Data persists in ignored `.local-pg/`. This fallback tests PostgreSQL queue semantics; it does not emulate Supabase Auth or the Data API, which this application does not use. Its PostgreSQL binary is supplied by the pinned `embedded-postgres` development dependency. macOS ARM64 was verified; run as an ordinary user, not root. Ctrl-C stops the database cleanly. Never start two copies.

In another terminal, create separate temporary credentials:

```sh
npm run key -- create submitter dashboard 24
npm run key -- create worker mac-worker 24
```

Each command prints a **file path**, never the token. Files live in ignored `.secrets/`, with mode 600; the database stores SHA-256 hashes only. Use the exact generated worker file path below:

```sh
npm run dev
```

Open [the dashboard](http://127.0.0.1:3000). Enter the `token` value from your local submitter credential file. Keys stay in browser memory, not cookies or local storage; refresh requires reconnecting. To copy a key privately to the macOS clipboard without printing it, substitute its generated path:

```sh
node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).token)' .secrets/submitter-dashboard-TIMESTAMP.json | pbcopy
```

Clear the clipboard after use. Then, in a third terminal:

```sh
WORKER_KEY_FILE=.secrets/worker-mac-worker-TIMESTAMP.json npm run worker
```

Queue a job through the dashboard. It should move queued → running → completed in about 5 seconds. Select `Simulate failure` to exercise failure reporting. The API and dashboard are one Next.js process. Worker logs are JSON lines on stdout; save locally using `npm run worker >> .worker/execution.log 2>&1` if desired (the directory exists after first startup).

For an optimized **local** build, stop the dev server and use:

```sh
npm run build
npm run start
```

No deployment is performed. Both server commands bind to loopback by default.

## Configuration

| Variable            | Process           | Purpose                                                 |
| ------------------- | ----------------- | ------------------------------------------------------- |
| `DATABASE_URL`      | Next.js / key CLI | Secret PostgreSQL connection string, in `.env.local`    |
| `DATABASE_SSL=true` | Next.js / key CLI | Enforce verified TLS for a hosted DB                    |
| `DATABASE_CA_FILE`  | Next.js / key CLI | Optional CA certificate file for verified DB TLS        |
| `ORCHESTRATOR_URL`  | Worker            | API origin, default `http://127.0.0.1:3000`             |
| `WORKER_KEY_FILE`   | Worker            | Required path to generated worker credential JSON       |
| `WORKER_STATE_DIR`  | Worker            | Default `.worker/<principal>`; preserve across restarts |

The worker accepts HTTP only for loopback; remote origins require HTTPS. It refuses redirects to avoid forwarding credentials. Use a separate worker principal and state directory for every worker instance. Do not copy a worker key to multiple machines or run parallel processes with that identity.

For a **new, dedicated** hosted Supabase project, manually put its direct or session-pooler PostgreSQL connection string in `.env.local`, enable verified TLS, and apply the SQL migration only to that project's database after checking the target. Supabase project creation and hosted migrations have intentionally not been run. This POC uses the server-side PostgreSQL connection rather than a Supabase service-role API key. No DB credentials or Supabase secrets use `NEXT_PUBLIC_*`. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) for connection options.

## API and permissions

Every `/api/*` operation requires `Authorization: Bearer <token>`. No browser Supabase access or public RLS policy is granted. The dashboard page shell is public, but all queue data requires authentication. Requests use Next.js [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers).

| Endpoint                                         | Role      | Behavior                                                           |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------ |
| `POST /api/jobs`                                 | Submitter | Create a job; UUID `Idempotency-Key` header required               |
| `GET /api/jobs?limit=100&before=<ISO timestamp>` | Submitter | Own jobs only; newest first, maximum 100                           |
| `GET /api/jobs/:id`                              | Submitter | Own job status, result, error and timestamps                       |
| `GET /api/workers`                               | Submitter | Worker ID, last seen, available and busy flags                     |
| `POST /api/heartbeat`                            | Worker    | Record availability for this key's worker identity                 |
| `POST /api/claim`                                | Worker    | Atomically claim one eligible job, or `{ "job": null }`            |
| `POST /api/jobs/:id/report`                      | Worker    | Renew lease / report completion / report failure using claim token |

Create body: `{ "title": "Test", "description": "Optional", "task": "simulate-development" }`. Supported task names: `simulate-development`, `simulate-failure`. Bodies reject unknown fields and are capped at 32 KiB; titles at 200 characters, descriptions and errors at 4,000. No task payload is interpreted as code or a shell command.

Report body: `{ "claim_token": "<UUID>", "action": "progress", "progress": 40 }`. `completed` requires a JSON object `result`; `failed` requires an `error` string. All successful responses are JSON. Job responses are wrapped as `{ "job": ... }`; lists use `{ "jobs": [...] }`. Submitters never receive claim tokens. Errors: 400 invalid input, 401 invalid/expired/revoked key, 403 wrong role, 404 missing/unowned job, 409 lease lost or idempotency conflict, 500 internal error.

A submitter can create and inspect its own jobs, not claim or execute them. A worker can claim from the shared queue and update only a current attempt assigned to its identity, not create or browse jobs. Submitters see worker availability across this single POC queue. Principals are identities; keys issued to the same role/principal intentionally share permissions and owned jobs.

## Reliability model

- The claim is one SQL statement with `FOR UPDATE SKIP LOCKED`, followed by an update under the same row lock. Different workers cannot acquire the same unexpired attempt.
- A claim gets a random token and a 30-second lease. Every progress report extends the lease by 30 seconds. The server uses database time, not worker time.
- Completion, failure, and progress updates require the worker ID, claim token, running status, and an unexpired lease. Old attempts are fenced after reclaim. Terminal acknowledgments with the same token/action are idempotent and preserve the first result.
- A dead worker's lease becomes eligible for reclaim. After three abandoned attempts, the job becomes failed on the next claim poll. There is no separate sweeper; without polling, expired rows remain visibly running until another worker polls. The dashboard displays lease timestamps to expose this state.
- Worker availability means a heartbeat was seen in the last 15 seconds; `busy` means the worker owns an unexpired running job. Availability is observational, not a reservation or authentication guarantee.
- The worker persists a private journal before running and persists its outcome before reporting. A network error stops the current simulation; it retries with bounded exponential backoff and a 5-second request timeout. On restart it renews the saved claim before repeating the simulation, or drops the journal if the lease was lost. A saved outcome is resent without repeating simulation work.
- Execution is **at least once**, not exactly once. A paused process can overlap a new lease owner after expiration; claim tokens prevent stale writes, while predefined simulations have no external side effects. Real execution would require idempotent effects and stronger fencing before integration.
- An exclusive local lock prevents two processes from using one journal. Ctrl-C/SIGTERM preserves the journal and removes the lock. After SIGKILL/power loss, inspect the PID in `.worker/<principal>/lock` and verify the process is gone before removing **only that lock**. Keep `journal.json`. Never delete a live worker's lock or recovery files.
- Lost create responses can be retried with the same UUID `Idempotency-Key` and identical body. Different content with the same key returns 409. The dashboard disables double-click submissions; for ambiguous network failures use the API with a stable request ID or inspect the list before submitting again.

This is a small trusted POC: one queue, no cancellation/requeue UI, no rate limiting, no scheduler, no external side effects. The dashboard shows the latest 100 jobs. Timestamp pagination is a convenience and can skip exact timestamp ties; retain job IDs and use individual lookups for integrations. The Next.js database credential is privileged and belongs only on the server. Before exposing this beyond a controlled temporary test, add operational limits and provision a dedicated least-privilege database role.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

Tests start their own PostgreSQL server on an ephemeral loopback port, apply the actual migration, and delete the temporary database afterwards. They do not read `.env.local` or contact cloud resources. They exercise request authentication/roles, creation/idempotency/validation, concurrent claims, `SKIP LOCKED`, claim-token secrecy, completion/failure, stale claims, attempt exhaustion, restart recovery, lost completion responses, availability, and private schema permissions/RLS. They call the same Request/Response handler used by Next.js, with real SQL rather than a mocked queue.

Optional real-browser smoke test (requires installed Google Chrome, a running local API and worker):

```sh
SUBMITTER_KEY_FILE=.secrets/submitter-dashboard-TIMESTAMP.json npm run smoke:browser
```

The browser test submits a real simulation and checks the displayed result against the API. It saves a credential-free screenshot under ignored `output/playwright/`. It does not print or persist the browser's Authorization headers.

See [manual acceptance tests](docs/manual-test.md), [Instinct integration](docs/instinct.md), and [verification evidence](docs/verification.md).
