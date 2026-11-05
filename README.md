# Conduit

**From a development request to a reviewable draft pull request.**

Conduit connects an assistant such as Instinct to a local Codex worker through an authenticated job API and a persistent PostgreSQL queue. Submit a task, track its execution, inspect the diff, and request revisions on the same PR.

The API coordinates the work; your local machine executes it. Each development task gets an isolated Git worktree, and verified changes become a **draft PR for human review**.

[Workflow](#how-it-works) · [Get started](#get-started) · [Security](#boundaries-and-security) · [Documentation](docs/README.md)

## What it can do

- **Track durable jobs.** UUID idempotency keys support submission retries with an identical body. Scoped credentials separate submitters from workers.
- **Work in registered repositories.** An administrator approves projects, base branches, workspace permissions and verification commands.
- **Run Codex in isolated worktrees.** Each root task gets a feature branch and retained workspace. The local worker executes one Codex task at a time in a network-disabled sandbox.
- **Publish for review.** Configured checks gate publication. Retrieve execution history, changed-file metadata, bounded diffs and draft PR details through the API.
- **Revise the same PR.** A revision is a new tracked job on the original branch and PR. Worktrees and recovery journals survive outcomes.

The implementation also supports success/failure simulation jobs for connectivity checks and `codex_task` jobs in a fixed TypeScript sandbox. These simulations are queue probes; there is no simulator UI or device simulator integration.

## How it works

```mermaid
flowchart TD
    A[Instinct / API client] -->|HTTPS| B[Next.js API on Vercel]
    B <-->|Verified TLS| C[(Supabase PostgreSQL queue)]
    D[Local Mac worker] -->|Outbound HTTPS| B
    D --> E[Isolated Git worktree]
    E --> F[Codex + offline checks]
    F -->|Trusted worker publishes| G[GitHub draft PR]
    G --> H[Human diff review]
```

The worker claims and reports jobs through outbound API requests; it needs no inbound tunnel or direct database connection. Codex and verification run in the sandbox; the trusted worker handles GitHub authentication, commits and publication outside it.

1. **Submit.** Send a `development` job for an approved project with instructions, acceptance criteria and a stable UUID `Idempotency-Key`.
2. **Execute.** The worker claims a leased job, prepares its worktree, runs Codex and executes administrator-configured checks.
3. **Inspect.** Retrieve `/api/jobs/:id/changes`, `/diff` and `/publication`. Diff responses are bounded and paginated.
4. **Revise.** Submit to `/api/jobs/:id/revisions` with a new idempotency key. The worker verifies and updates the same branch and draft PR.

For development jobs, `completed` means verified code was published to a branch with an open draft PR. Review and merge remain human decisions. Conduit does not merge or deploy; **existing connected hosting may independently auto-deploy `main` after a merge**.

## Get started

Use **Node.js 24.x** and npm. Real Codex execution also requires the supported macOS sandbox, a local Codex login and prepared dependencies. Running the API alone does not provide a worker.

### 1. Verify a checkout

In a trusted local development environment, outside the offline worker sandbox:

```sh
npm ci
npm test
npm run build
npm run typecheck
```

The full suite starts disposable loopback PostgreSQL clusters, a real HTTP API and worker processes; do not run it as root. No Docker is required. Real Codex and live GitHub checks need separate opt-in setup in the runbooks.

**Worker verification is narrower.** The documented repository profile runs Next route-type generation, TypeScript checking and offline unit tests. It excludes database/network checks and certain subprocess harnesses. Passing that profile does not establish that the full suite passes. Run the complete suite separately before merging. See [verification scopes and historical evidence](docs/README.md#verification-and-history).

### 2. Choose an API and queue

- **Local development:** follow the [local setup guide](docs/operator-guide.md#local-setup-and-full-verification) for `npm run db:local`, restricted runtime provisioning, private configuration and `npm run dev`. Preserve existing configuration before bootstrap commands write local files.
- **Hosted installation:** follow the [Vercel + Supabase runbook](docs/deployment.md). Schema migration, runtime credentials and key administration are separate operator responsibilities.

### 3. Connect a worker

| Credential                   | Access                                                                   | Browser storage                          |
| ---------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `cnd_live_` API key          | Existing assigned principal and scopes                                   | GUI viewer key: React memory only        |
| Supabase Auth email/password | Exactly `jobs:read`, only after explicit admin UUID-to-principal mapping | Session in localStorage across refreshes |

See [console authentication and storage risks](docs/gui.md) and [account administration](docs/operator-guide.md#supabase-auth-account-links). Supabase Auth does not change worker authentication or `/auth-check`.

For GUI access, use `npm run key -- create --type viewer --principal ID --name NAME` with the job owner's principal. This key has only `jobs:read` and cannot create, revise, claim, or update jobs. Paste it into Connect; the GUI holds it in React memory only.

Issue separate submitter and worker keys through the [local key-management CLI](docs/operator-guide.md#persistent-api-keys), then start the worker against your API:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
WORKER_KEY_FILE=.secrets/worker.json \
WORKER_STATE_DIR=.worker/your-worker \
npm run worker
```

Use `http://127.0.0.1:3000` for loopback development. Keep the state directory across restarts and use a separate one for each queue/worker identity. Credentials stay in private local files.

Prove the queue/worker loop with the [smoke and recovery checks](docs/manual-test.md). To execute repository tasks, complete [project registration, GitHub policy, Codex setup and verification configuration](PHASE_4_TESTING.md) first; a queue-only installation cannot publish development PRs.

## API at a glance

All `/api/*` routes require scoped bearer authentication. The [API and queue guide](docs/operator-guide.md#api-contract) covers payloads, errors and lease behavior; the [development runbook](PHASE_4_TESTING.md) adds projects, revisions, artifacts and publication.

| Route                          | Purpose                            |
| ------------------------------ | ---------------------------------- |
| `POST /api/jobs`               | Submit an idempotent job           |
| `GET /api/jobs/:id`            | Read status, phase and result      |
| `GET /api/projects`            | Discover approved projects         |
| `GET /api/jobs/:id/diff`       | Review actual changes              |
| `POST /api/jobs/:id/revisions` | Request a same-PR revision         |
| `GET /api/workers`             | Observe recent worker availability |

`/info` is a **static code-derived descriptor**, available as JSON or HTML; it proves no live readiness. `/health` checks API/database access, `/auth-check` validates credential access, and `/api/workers` reports recent heartbeats. A completed probe establishes the end-to-end loop; a heartbeat alone is no execution guarantee.

## Boundaries and security

Conduit is an engineering prototype with explicit operator responsibilities:

- **At-least-once execution.** Lease fencing rejects stale reports and journals support recovery, but idempotent submission does not make execution exactly once. Interrupted edits, conflicts and stale locks can require manual recovery.
- **Local trust boundary.** The administrator controls registration, workspace permissions, credentials and verification. Jobs cannot widen that policy. Sandbox isolation and heuristic secret detection do not constitute a security audit.
- **Credential limits.** `strict_bot` is the default GitHub policy and audits required repository restrictions. Explicit `prototype` mode can use an existing GitHub login or PAT with merge/admin capabilities. See [policy and credential requirements](PHASE_4_TESTING.md#github-security-policies-and-credentials).
- **Private configuration.** Submitter/worker keys are scoped and revocable; the database stores their hashes. Runtime, key-management and schema-administrator access are separate. Keep environment files, keys, journals and private project configuration out of commits and shared logs.
- **Human control.** No automatic merge, draft-to-ready transition, deployment or destructive worktree cleanup. Review repository protections and connected deployment triggers before merging.

The read-only web console supports API keys and Supabase Auth email/password accounts with explicit administrator workspace mappings. Hosted readiness, external Instinct acceptance and live Codex/GitHub verification must be established for each installation; historical results are not current guarantees.

## Repository map

| Path                                                          | Contents                                          |
| ------------------------------------------------------------- | ------------------------------------------------- |
| [src/app/](src/app/)                                          | Next.js HTTP routes                               |
| [src/lib/](src/lib/)                                          | Authentication, queue, development API and checks |
| [worker/](worker/)                                            | Outbound worker, Codex execution and publication  |
| [scripts/](scripts/)                                          | Local administration and smoke probes             |
| [supabase/migrations/](supabase/migrations/)                  | Versioned schema and permissions                  |
| [tests/](tests/) · [sandbox/typescript/](sandbox/typescript/) | Test suites and fixed Codex fixture               |
| [docs/](docs/README.md)                                       | Setup, integration, recovery and evidence index   |

Start with the [documentation index](docs/README.md) for the operator guides, API contracts and retained implementation history.
