# Phase 3: real local Codex execution

Phase 2 is committed as `838afee`. Phase 3 retains the same authenticated API,
PostgreSQL leases, worker key scopes, simulation tasks, and terminal statuses.
Only `typescript-sandbox` is an allowed Codex project. No project paths or
verification shell commands are accepted from clients.

## Setup

Use **Node 24** and `npm ci`. The official standalone Node distribution is
recommended on macOS: Homebrew Node builds can need shared libraries outside
Codex's minimal readable runtime. A failing sandbox preflight stops the job;
do not widen permissions to work around it.

Run `codex login` and `codex login status` locally. ChatGPT login works; an
OpenAI API key is unnecessary. This POC supports a file-backed
`$CODEX_HOME/auth.json` login (`~/.codex/auth.json` by default). If your login is
keychain-only, configure Codex's officially supported file credential storage
and log in again. Never paste credentials into a task or this document.

The pinned official TypeScript SDK includes its Codex runtime. It receives a
fresh credential directory containing only the local login and worker-generated
configuration. It does not inherit personal plugins, MCP servers, or app access.
See the official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and
[permission profile](https://learn.chatgpt.com/docs/permissions) documentation.
Task commands get a minimal environment and cannot read this credential directory.

Apply `supabase/migrations/20261105015635_codex_tasks.sql` to the **existing POC
project** using the existing migration process, before deploying the API:

```sh
CONDUIT_ADMIN_ENV_FILE=.env.schema-admin.local npm run db:migrate -- --project-ref YOUR_20_CHARACTER_PROJECT_REF
npm run build
npm run typecheck
```

Schema administration credentials belong only on the administrator machine.
The worker uses its existing `jobs:claim` / `jobs:update` bearer key and never
needs database credentials. The API keeps its existing restricted runtime login.
The migration adds input columns and extends the task constraint. Results use
the existing JSONB column, including results accompanying a failed job.

Deploy the API to the existing Conduit Vercel project using the established
Phase 2 deployment process. Do not start Codex inside Vercel.

## Start the worker

Create a private `.env.worker.local` from `.env.worker.example`:

```dotenv
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app
WORKER_KEY_FILE=.secrets/worker.json
WORKER_STATE_DIR=.worker/hosted-mac-worker
CODEX_TIMEOUT_MS=180000
# Optional: CODEX_HOME=/Users/YOU/.codex
# Optional: CONDUIT_CODEX_MODEL=YOUR_ACCOUNT_SUPPORTED_MODEL
```

Required: API origin, worker credential file, local Codex login, Node 24.
`WORKER_STATE_DIR` defaults to `.worker/<worker-principal>`; use a dedicated
state directory per API origin. `CODEX_TIMEOUT_MS` defaults to 180000 and accepts
1000–600000. Each verification command has its own fixed 30-second timeout.
`CONDUIT_CODEX_MODEL` is optional; otherwise Codex chooses its default model.

```sh
chmod 600 .env.worker.local .secrets/worker.json
node --env-file=.env.worker.local --import tsx worker/index.ts
```

Alternatively export those variables and run `npm run worker`. Run one worker
process for this POC. The existing exclusive state lock and sequential loop
allow one active job. Do not launch multiple workers with different state
directories against this queue. Stop the Phase 2 worker before replacing it.

## Submit a development job

Use an Instinct/submitter key, never the worker key. These are placeholders:

```sh
curl --fail-with-body https://YOUR-PROJECT.vercel.app/api/jobs \
  -H 'Authorization: Bearer YOUR_INSTINCT_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 11111111-1111-4111-8111-111111111111' \
  --data '{
    "task": "codex_task",
    "project": "typescript-sandbox",
    "title": "Implement average",
    "instructions": "Create and export an average(numbers: number[]) function. Return 0 for an empty array. Add unit tests covering empty arrays, positive values, and negative values.",
    "acceptance_criteria": "Export average from src/index.ts. TypeScript and all tests pass."
  }'
```

Generate a fresh UUID for every distinct request. Reuse the same UUID only when
retrying identical content. `acceptance_criteria` is optional text; it is passed
to Codex, not interpreted as a command or automatically proven by the worker.
The older `simulate-development` and `simulate-failure` requests remain valid.

A repeatable probe that submits, polls, checks the outcome, and saves evidence:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
SUBMITTER_KEY_FILE=.secrets/<submitter-key>.json \
npm run smoke:codex -- --scenario average
```

The probe prints its job/request IDs immediately. If interrupted, retrieve the
printed job ID; do not blindly create another job. Resume polling/assertions:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
SUBMITTER_KEY_FILE=.secrets/<submitter-key>.json \
npm run smoke:codex -- --scenario average --job-id YOUR_JOB_UUID
```

## Retrieve results and inspect files

```sh
curl --fail-with-body https://YOUR-PROJECT.vercel.app/api/jobs/YOUR_JOB_UUID \
  -H 'Authorization: Bearer YOUR_INSTINCT_API_KEY'
```

Poll until `job.status` is `completed` or `failed`. Successful completion requires
both `result.execution.status = completed` and
`result.verification.status = passed`. A completed Codex turn with failing tests
has job status `failed`. Inspect `result.verification.checks` for the actual exit
codes and bounded output. `result.events` contains event kinds and item kinds,
not raw command transcripts. The result also includes a Codex thread ID when
available, public attempt UUID, worker ID, queue attempt count, timestamps,
summary, relative changed-file paths, sandbox preflight and error details.
The private claim token is excluded from submitter responses.

`result.workspace` is an absolute path on the worker Mac. The smoke probe saves
the API response to `output/phase3-<job-id>.json`. Use the returned workspace:

```sh
cat /ABSOLUTE/RETURNED/WORKSPACE/src/index.ts
cat /ABSOLUTE/RETURNED/WORKSPACE/test/average.test.mjs
```

Test filenames are chosen by Codex. List the returned `test/` directory first
if needed. Files are retained in the operating system's temporary directory for
inspection; they may disappear on reboot or OS cleanup. The API does not serve
source files. Remove old `conduit-codex-*` attempt directories manually only
after confirming they are inactive. Credential directories are removed after
execution, and recovery state records an unfinished workspace for cleanup.

The baseline lives in `sandbox/typescript`. Every execution, including a retry,
copies it into a newly created temporary project and copies the installed pinned
TypeScript compiler into read-only dependencies. There is no network install
inside a task. Package/config files and dependencies are read-only to Codex.
The worker runs fixed argument arrays equivalent to:

```sh
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json
node --test --test-timeout=20000 'test/*.test.mjs'
```

Both run through the SDK's pinned `codex sandbox -P conduit` command, with
command networking disabled. The worker never runs client-provided commands or
Codex-modified npm scripts. The baseline npm scripts are conveniences for local
baseline inspection; they are not used by the worker.

## Failure, timeout, and recovery testing

With the worker running normally:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
SUBMITTER_KEY_FILE=.secrets/<submitter-key>.json \
npm run smoke:codex -- --scenario failure
```

This asks Codex to add an intentionally failing `assert.equal(1, 2)` test.
The probe succeeds only if the job fails, Codex execution completed, and unit
verification actually returned a nonzero exit code.

For timeout handling, stop the worker and restart it with
`CODEX_TIMEOUT_MS=1000`, then submit:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
SUBMITTER_KEY_FILE=.secrets/<submitter-key>.json \
npm run smoke:codex -- --scenario timeout
```

Restore the normal timeout afterward. The job must fail with a timeout or
interruption error. Verification may still run against its partial workspace;
passing verification cannot override failed execution.

The worker renews its claim during execution and verification. A failed renewal
aborts execution. API 409 drops the stale journal; other transport failures
retry with backoff. An interrupted execution gets a fresh workspace on retry.
Completed outcomes are journaled before submission, so a lost terminal response
is retried without rerunning Codex. Queue claim tokens fence older attempts.

For a restart experiment, interrupt the worker during a task, restart with the
same state directory and credentials, and retrieve the job. A graceful signal
aborts the current job; after an abrupt crash, the SDK supervisor detects its
parent disconnect and aborts. If a crash leaves the exclusive `lock` file,
verify that the worker and its supervisor are gone before removing **only** the
lock file and restarting. Preserve `journal.json` and `origin`. Never steal a
live lock. Expired leases can be reclaimed up to the existing three-attempt
limit. A restart does not resume a partial Codex conversation.

## Automated checks and observed results

Run from the repository with Node 24 on PATH:

```sh
npm ci
npm test
npm run build
npm run typecheck
RUN_REAL_CODEX=1 node --import tsx --test tests/real-codex.test.ts
```

The default suite skips the account-consuming real-Codex test. The opt-in test
creates a disposable PostgreSQL database and HTTP API, issues scoped keys,
starts a separate worker process, and checks average success, intentional unit
failure, forced timeout, stored results, source changes, unique workspaces, and
credential cleanup. It injects one lease-renewal HTTP 503 and one worker
SIGKILL/restart, asserting fresh workspaces and old-credential cleanup. It uses the actual SDK and existing local login. Results
are written to `output/phase3-real-local.json`; no keys are included.

Verification record, November 4–5, 2026 (America/Chicago):

- Real local SDK average task: source/test files changed, TypeScript exit 0,
  four unit tests passed, sandbox preflight passed.
- Intentional failure: Codex completed, TypeScript exit 0, unit tests exit 1,
  overall job failed.
- Real HTTP/PostgreSQL/separate-worker test: passed all three scenarios,
  including timeout, storage equality and API result retrieval.
- Normal suite: 31 passed, 0 failed, 1 explicitly skipped opt-in test.
  Build and TypeScript checks passed.
- Real recovery checks: renewal failure and SIGKILL/restart passed with fresh
  workspaces; stale credentials were removed.
- Hosted Supabase migration applied and its new constraints queried successfully.
- Hosted API deployment: `dpl_Ds7DNgTCKLuGpkS4crMHVBM34qRy` is READY at
  `https://YOUR-PROJECT.vercel.app`, using the existing Supabase runtime connection.
- Hosted average task `0638ba96-f9d3-4de1-babf-763b4a9ad8ca`: completed on
  `mac-worker`, attempt 1. Source and test files changed; TypeScript exit 0;
  four unit tests passed. The authenticated API returned the stored result.
- Hosted intentional-failure task `549f8bc5-7ef2-432e-8ce0-413ad5ab8e11`:
  Codex completed, TypeScript exit 0, unit tests exit 1, job failed. Supabase
  rows independently matched the API outcomes for both real tasks.
- Hosted simulation regression `b9c8db57-c085-43f2-b736-8f8056840937`: completed.
  Health returned 200; unauthenticated job access returned JSON 401.
- Instinct independently submitted and polled real job
  `58d0176a-2573-4e4e-84b9-7a2694299fa7`: POST 201, completed on `mac-worker`,
  attempt 1, `simulated: false`, TypeScript exit 0 and four unit tests passed.
  The generated implementation and test files were subsequently inspected on
  the Mac at `/tmp/conduit-codex-fGlaN2/project`. They contain the exported
  average function and the three requested test cases. That inspection did not
  rerun verification; exit codes come from the worker's recorded execution.
- Hosted acceptance completed November 5, 2026. Evidence is saved locally in
  `output/phase3-hosted.json` and each `output/phase3-<job-id>.json`.

The Node 24 Phase 3 worker is running with the existing scoped worker key and
`.worker/hosted-mac-worker` recovery state. Its log is `output/worker-phase3.log`.
On this Mac the tested standalone runtime is installed at
`.worker/toolchains/node-v24.22.2-darwin-arm64/bin/node`. Keep the Mac awake and
the worker running during Instinct tests. This detached process is not a
persistent login/startup service; after reboot, restart the worker using the
setup instructions above.

## Known limitations

This is a single-worker experiment, with no dashboard, GitHub integration,
Simulator automation, multi-agent scheduling, or arbitrary project selection.
Run it only with development tasks from trusted submitters.

Codex permission profiles are a supported **beta** configuration, pinned here
through SDK/CLI 0.166.0. macOS with official Node 24 is the tested host; Linux and
Windows need their own sandbox validation. A failed sandbox or login fails the
job; the worker never switches to full access. Network access for Codex model
inference is necessary, while task commands have networking disabled.

Verification runs baseline and generated tests; it is not an independent proof
of natural-language acceptance criteria. Logs/summary outputs are capped and
common credential patterns redacted. Changed-file listings are limited to 50
paths and disclose truncation. Workspace scanning rejects symlinks and enforces
file/depth/size bounds; there is no comprehensive CPU/memory/disk quota or
automatic artifact retention policy. Queue rows contain the final attempt's
result; this phase adds no historical attempt table or raw transcript store.

File-backed login is copied for each run and deleted afterward; token refresh
in that temporary copy is not propagated to the original login. Reauthenticate
locally if the source login expires. A machine/power failure before cleanup can
leave a private temporary credential directory; the worker cleans a recorded
unfinished attempt when restarting with the same state and temporary root.
The existing manual stale-lock procedure remains deliberate.

Supabase security advisors reported only the existing informational
[RLS enabled without policy notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
for the intentionally private `conduit_meta.schema_migrations` table. No new
public grants or RLS policies were introduced.
