# Phase 4: persistent projects, worktrees and draft pull requests

Phase 4 extends the existing Next.js → private Supabase PostgreSQL → local Mac worker pipeline. Simulation and `codex_task` / `typescript-sandbox` requests keep their Phase 3 behavior. Nothing in this phase deploys application code, creates repositories, enables auto-merge, merges a PR, or marks a draft ready.

## Architecture and persistence

- `projects` contains administrator-approved GitHub identities, enabled flags and allowed base branches. It contains no worker paths or GitHub credentials.
- The private administrator-owned `CONDUIT_PROJECTS_FILE` contains worker-local paths, storage mode, verification argv and workspace policy. The HTTP API cannot register or alter projects.
- An independent `development` job is the root development task. `development_tasks` links it to a deterministic feature branch, immutable original base commit, current head, PR and publication checkpoint. Full UUID branch names avoid collisions.
- A revision is another queue job with the same `root_job_id`. It has its own instructions, acceptance criteria, timestamps, errors and results. It starts from the current approved published head at claim time.
- `execution_attempts` retains every claim/recovery attempt and its starting SHA. Terminal attempts are not overwritten by later claims. `change_artifacts` retains the attempt's execution and cumulative PR file metadata and bounded unified diffs.
- Worktrees and execution journals survive outcomes. GitHub is the durable store for published code. There is no automatic worktree or branch deletion.

Queue `status` is `waiting_dependencies`, `queued`, `running`, `completed`, `failed` or `blocked`. During a running lease, `phase` distinguishes `claimed`, `running`, `verifying`, `publishing`. Existing status/lease fencing remains intact. Verification has its own `passed`, `failed` or `not_run` outcome. `completed` means a verified commit is durable on a branch with an open draft PR; it does not mean review or merge occurred.

A unique database index plus task-row coordination prevents concurrent executions on a feature branch. A private filesystem lock provides additional protection against a stale local process. The worker still executes one Codex task at a time. Multiple independent jobs and revisions can queue.

## Install and migrate

Use official standalone Node **24.x** for real Codex execution. The existing sandbox fails closed on other Node versions. Tests that mock Codex can run on the current development runtime.

```sh
npm ci
npm test
npm run build
npm run typecheck
```

The additive migration is `supabase/migrations/20261105062426_persistent_projects.sql`. It upgrades the existing schema, creates four private RLS-enabled tables, extends queue fields/statuses and permits the `jobs:revise` scope. It does not revoke working keys or import/replay jobs.

Use the schema administrator connection, **not** the key-management-only login. Preserve private environment files. For an already tracked hosted installation:

```sh
CONDUIT_ADMIN_ENV_FILE=.env.schema-admin.local \
  npm run db:migrate -- --project-ref YOUR_20_CHARACTER_PROJECT_REF
```

For a separate local development database, use its administrator environment file and `npm run db:migrate -- --local`. The migration CLI validates the target. Apply the migration before deploying this API/worker version through the existing Vercel workflow. This implementation does not apply cloud migrations or deploy automatically.

## GitHub security policies and credentials

Security policy is local administrator configuration, separate from the cloud registry and job payloads. No database migration is needed for this policy adjustment. Set `CONDUIT_GITHUB_SECURITY_FILE` to a private **mode-600 JSON file** before registration and worker startup. If unset, the policy is `strict_bot`. An explicit file can contain `{"policy":"strict_bot"}`. Missing/unreadable/invalid configured files fail; there is **no automatic fallback** between policies. Instinct cannot select or override a security policy.

### `strict_bot` (default)

Preserves the original requirement: the GitHub identity has ordinary Write access, no Maintain/Admin role, and no bypass of the approved base's active update-restriction ruleset. Each approved base must also require at least one approving PR review. Auto-merge must be disabled. Only repository-administrator bypass actors are supported; hidden bypass actors require the read-only audit token described below. Unsupported or unverifiable policy fails closed.

The publishing PAT must be fine-grained and selected-repository scoped: Metadata read, Contents read/write, Pull requests read/write. A separate bot's fine-grained PAT is **not supported by GitHub for repositories where that bot is an outside/repository collaborator**, including a personal repository owned by another user. Use this policy only with an ownership/membership arrangement supported by GitHub. It is not the practical personal-owner setup below.

For strict mode, configure an active repository ruleset on every approved base with **Restrict updates**, and no bypass actors except Repository administrators (role ID 5). Require PR review and block force pushes/deletion; leave `conduit/job-*` branches outside the update restriction. The worker must not have an administrator/bypass role. Use a separate review ruleset with no bypass if human administrators should also be required to obtain an approval before merging.

GitHub can hide ruleset bypass actors from a non-admin bot. If necessary, supply `CONDUIT_GITHUB_POLICY_TOKEN_FILE` pointing to a second mode-600 fine-grained PAT owned by a human administrator, with **Administration read and Metadata read only**, scoped to the selected repository. Do not grant Contents write, Pull requests write or Administration write to this audit token. Code restricts it to GET ruleset details; it is never passed to Git, Codex or verification. Missing audit visibility causes strict registration/publication to fail.

### `prototype` (explicit development-only opt-in)

This mode supports your existing local GitHub CLI login, a classic PAT, or a fine-grained PAT. The repository owner's identity is accepted; no bot account, rulesets, mandatory PR approvals, Administration permission or separate policy-audit token is required. Public and private repositories are supported, subject to GitHub's availability of draft PRs for that repository.

Create a private `/Users/YOU/Conduit/config/github-security.json`:

```json
{
  "policy": "prototype",
  "acknowledge_prototype_risk": true,
  "approved_repositories": ["YOUR_OWNER/YOUR_REPO"]
}
```

```sh
chmod 600 /Users/YOU/Conduit/config/github-security.json
export CONDUIT_GITHUB_SECURITY_FILE=/Users/YOU/Conduit/config/github-security.json
```

Repository entries are exact `OWNER/REPO` names (case-insensitive), without wildcards. The repository must also be registered with both the cloud API and the local worker registry. Job and registration payloads cannot select the security mode. Invalid or missing configured files fail without fallback; the previous experimental `prototype_owner_token` JSON must be replaced with the configuration above.

Choose either authentication method:

1. **Existing GitHub CLI login:** run `gh auth login --hostname github.com` if needed, then `gh auth status --hostname github.com`. Leave `CONDUIT_GITHUB_TOKEN_FILE` unset. The trusted local worker calls the fixed command `gh auth token --hostname github.com` and captures the credential privately. It uses the CLI's active account and supports `GH_CONFIG_DIR` / `XDG_CONFIG_HOME`. Environment token overrides (`GH_TOKEN`, `GITHUB_TOKEN`) are deliberately not inherited by that command; use a private token file for an administrator-supplied token. Start the worker under the same OS user with access to the CLI's credential store.
2. **Administrator token:** put only the token in a private mode-600 file outside repository/worktree directories and export `CONDUIT_GITHUB_TOKEN_FILE=/Users/YOU/Conduit/secrets/github-token`. Classic (`ghp_`) and fine-grained (`github_pat_`) tokens are accepted. A configured token file takes precedence over CLI login; invalid, unreadable or insecure files fail without falling back to another identity. For a fine-grained PAT, select the intended repository and grant Metadata read, Contents read/write, and Pull requests read/write. Classic PATs need appropriate repository access (`repo` for private repositories, or `public_repo` for public-only use). Use a short expiry and avoid extra privileges.

Use the same exports for project registration and worker startup. Restart the worker after changing policy or authentication configuration. `CONDUIT_GITHUB_POLICY_TOKEN_FILE` is ignored in prototype mode. Registration output, execution results and draft PR bodies identify the selected mode and include a credential-free risk warning.

Prototype checks the registered repository's identity, canonical HTTPS remote, expected default branch, approved base existence, read/write access and non-archived state. It does not query branch rules or protection APIs, audit approval counts, or require repository settings changes. Existing GitHub rules still apply to pushes and PRs. Repository auto-merge availability does not block prototype mode; Conduit never enables or requests automatic merging.

**Development risk:** owner credentials and broad classic/CLI tokens can retain administrative and merge permissions outside Conduit's workflow. The local allowlist restricts Conduit's requests, not a stolen token. No branch-rule audit guarantees that a compromised trusted worker cannot merge or change other branches. Human review is required before merging. Keep prototype mode local to an experimental installation; never enable it in a public deployment's defaults or embed these credentials in distributed configuration.

Conduit still publishes only to independent `conduit/job-*` branches, uses ordinary fast-forward pushes, creates draft PRs, and updates the original PR for revisions. It never pushes to approved base/default branches, force-pushes, resets the existing checkout, automatically merges, or changes GitHub settings. API authentication, job ownership, verification, worktree isolation and recovery checks remain active.

### Switch back to strict mode

Stop the local worker, replace the local security file with `{"policy":"strict_bot"}` (or unset `CONDUIT_GITHUB_SECURITY_FILE`), configure the strict fine-grained publisher token and required repository policy described above, then restart. Strict mode does not use `gh` fallback, accept classic/CLI OAuth tokens, or relax rules when validation fails. Re-run registration validation or a development job to check the strict configuration. No cloud schema change is needed.

### Credential isolation (both modes)

Instinct, the API and Supabase never receive GitHub credentials. Trusted Git uses an ephemeral askpass helper and a scrubbed environment, never a credential-bearing remote URL. Codex and verification inherit an explicit environment allowlist without GitHub tokens or configuration variables. Their sandbox denies token files, GitHub CLI configuration (including custom locations), local Keychain storage, local security configuration. Git metadata is readable for inspection; commits and publication are managed by the worker. The CLI token command has fixed arguments, bounded output/time, no shell and sanitized errors; raw stdout/stderr are never logged on failure. Keep credential files outside project, dependency and worktree directories.

References: [GitHub CLI token retrieval](https://cli.github.com/manual/gh_auth_token), [PAT permissions and limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [strict rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [draft PR API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

## Register a project locally

Choose a fixed UUID (`uuidgen`) and an approved storage directory. Store registration JSON outside the repository. Example `/Users/YOU/Conduit/config/conduit-registration.json`:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "conduit",
  "repository_owner": "YOUR_OWNER",
  "repository_name": "conduit-poc",
  "default_branch": "main",
  "allowed_base_branches": ["main"],
  "local": {
    "mode": "existing",
    "repository_path": "/Users/YOU/Coding/Apps/conduit-poc",
    "storage_root": "/Users/YOU/Conduit",
    "remote": "origin",
    "verification": [
      {
        "name": "typecheck",
        "argv": [
          "/ABSOLUTE/NODE24/bin/node",
          "node_modules/typescript/bin/tsc",
          "--noEmit"
        ],
        "timeout_ms": 60000
      },
      {
        "name": "unit_tests",
        "argv": ["/ABSOLUTE/NODE24/bin/node", "--test", "test/*.test.mjs"],
        "timeout_ms": 60000
      }
    ],
    "policy": {
      "allowed_paths": ["src/", "test/", "README.md"],
      "read_only_paths": ["package.json", "package-lock.json", "tsconfig.json"]
    }
  }
}
```

Adjust the verification commands to the repository. `argv` is an argument vector, **not a shell string**. Shell metacharacters and globs are not expanded by a shell; Node's own test runner supports its test glob syntax. The example checks fit a small TypeScript/Node fixture. Conduit's own test suite starts PostgreSQL and HTTP servers; its current network-disabled sandbox cannot run that suite unchanged. Use an explicitly approved sandbox-compatible verification profile for initial self-development, and run Conduit's complete suite manually before merging. This is a known limit, not a claim of full automated self-hosting verification.

Policy entries are exact files or directory prefixes ending in `/`; `*` permits project paths except `.env`/`.env.*` files and `.ssh` directories. Workflows, dependencies, generated files and project configuration may change. Git metadata is readable for tooling; Conduit manages commits and publication. Symlinks/submodules, binary/oversized blobs and obvious secrets still require manual artifact handling. Optional `read_only_paths` entries apply when configured.

If checks need dependencies, provision them separately as an administrator. Optionally add `"dependency_directory": "/Users/YOU/Conduit/dependencies/PROJECT_UUID/node_modules"` inside `local`. Install the matching lockfile's dependencies there in a trusted terminal, before starting the worker. The worker copies that directory into a writable worktree-local `node_modules`, using filesystem clones when available. Legacy worker-created symlinks are replaced by private copies; the original dependency directory remains untouched. Keep `node_modules/` ignored. The sandbox remains offline, so unavailable packages need trusted preparation; dependency files and manifests may be edited locally.

```sh
export CONDUIT_PROJECTS_FILE=/Users/YOU/Conduit/config/projects.json
export CONDUIT_ADMIN_ENV_FILE=/ABSOLUTE/PATH/conduit-poc/.env.schema-admin.local
npm run project -- add --config /Users/YOU/Conduit/config/conduit-registration.json
npm run project -- list
npm run project -- inspect 11111111-1111-4111-8111-111111111111
npm run project -- disable 11111111-1111-4111-8111-111111111111
```

`add` verifies GitHub policy, local path, selected remote identity and remote base refs before inserting the cloud record. The private local registry is written atomically with a lock. A cloud insert followed by local-file failure is safe: rerun with the **same UUID** to finish registration. Conflicting policy is rejected instead of silently overwritten. The registry and storage directories must be writable only by trusted local administrators/worker users.

**Managed mode:** set `mode` to `managed` and omit `repository_path`. Conduit clones a persistent **bare** repository into `<storage_root>/projects/<project-id>`. Bare storage has no default checkout to disturb. Clone interruptions require manual inspection of the partial repository before retry; it is never automatically deleted.

**Existing mode:** the selected `origin` may be a normal HTTPS or SSH GitHub URL for the same owner/repository. The remote URL is validated but never rewritten. The checkout's branch, staged index, dirty files and untracked files remain intact. Fetches update shared Git objects; task branches/worktree metadata are added. All trusted network operations use the approved credential-free HTTPS URL. Unsupported local URL rewrites, configuration includes, filters and credential/HTTP overrides fail closed.

Both modes use `<storage_root>/worktrees/<project-id>/<root-job-id>` for the task worktree and reuse it for revisions. Recreating a clean, removed worktree from the recorded feature head is supported. A different local head, dirty worktree, branch identity mismatch or changed remote head blocks execution rather than resetting user work.

## Start the worker

The worker environment is not loaded from `.env.local`. Configure it in your trusted shell/service:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
WORKER_KEY_FILE=/ABSOLUTE/PATH/.secrets/worker.json \
WORKER_STATE_DIR=/ABSOLUTE/PATH/.worker/hosted-phase4 \
CONDUIT_PROJECTS_FILE=/Users/YOU/Conduit/config/projects.json \
CONDUIT_GITHUB_SECURITY_FILE=/Users/YOU/Conduit/config/github-security.json \
CODEX_TIMEOUT_MS=180000 \
npm run worker
```

Use existing file-backed `codex login` and official Node 24 as in `PHASE_3_TESTING.md`. No database credentials belong in the worker environment. Keep one active worker, its state directory and its project registry across restarts. Optional `CONDUIT_CODEX_MODEL` selects an account-supported model. Verification timeouts are set per local check (1–600 seconds). Worker HTTP calls remain bounded; leases renew during execution and publication.

## Instinct API contract

All endpoints use existing bearer API keys and ownership isolation. Existing `jobs:read` keys can read projects/review packages. Newly issued Instinct keys include `jobs:revise`; existing keys retain their scopes and must be rotated with the same principal to acquire revision permission. Worker keys keep `jobs:claim` / `jobs:update`. There is no administrative HTTP scope.

| Endpoint                        | Scope         | Purpose                                                  |
| ------------------------------- | ------------- | -------------------------------------------------------- |
| `GET /api/projects`             | `jobs:read`   | Up to 100 enabled cloud project records; no local paths  |
| `GET /api/projects/:id`         | `jobs:read`   | Enabled project identity and approved bases              |
| `POST /api/jobs`                | `jobs:create` | Existing tasks or a new `development` job                |
| `GET /api/jobs/:id`             | `jobs:read`   | Status, phase, bounded result and verification           |
| `GET /api/jobs/:id/publication` | `jobs:read`   | Current branch, base/head SHAs, PR and publication state |
| `GET /api/jobs/:id/executions`  | `jobs:read`   | Attempt history, starting SHAs, terminal results/errors  |
| `GET /api/jobs/:id/changes`     | `jobs:read`   | Structured changed files                                 |
| `GET /api/jobs/:id/diff`        | `jobs:read`   | Unified diff chunks                                      |
| `POST /api/jobs/:id/revisions`  | `jobs:revise` | Queue another execution on the same feature branch       |
| `GET /api/jobs/:id/revisions`   | `jobs:read`   | Root job and up to 99 revisions in creation order        |

Create and revision requests require a UUID `Idempotency-Key` header. Reuse the same header/body after an ambiguous HTTP response. Supply JSON and bearer authentication through your client, keeping credentials out of captured terminal output.

Example development body:

```json
{
  "task": "development",
  "project_id": "11111111-1111-4111-8111-111111111111",
  "title": "Add input validation",
  "instructions": "Validate the requested input and add unit coverage.",
  "acceptance_criteria": "Empty input is rejected; configured verification passes.",
  "base_branch": "main",
  "dependency_job_ids": []
}
```

Unknown properties, paths, commands, remotes, repository URLs, disabled/unknown projects and unapproved base branches are rejected. Dependencies reference existing owned **root development jobs** in the same project and base branch. Immutable edges point only backwards to existing jobs, making cycles impossible to submit. Dependencies wait for GitHub's **merged** state; completed-but-unmerged jobs do not qualify. Failed/blocked prerequisites or PRs closed without merging block dependents. No cherry-picking, merging, stacking or rebasing happens automatically.

A revision body contains `instructions` and optional `acceptance_criteria`. It requires an open draft PR with successfully published state:

```json
{
  "instructions": "Also handle whitespace-only input and add a regression test.",
  "acceptance_criteria": "Existing and new tests pass."
}
```

The revision can reference the root or any owned revision; `root_job_id` stays constant. Revisions reuse branch contents rather than depending on an old Codex conversation. Each execution starts a fresh SDK thread; its ID is retained where available. No old conversational context is required.

Worker-only routes are `POST /api/jobs/:id/publication`, `POST /api/jobs/:id/artifacts`, `POST /api/development/pending` and `POST /api/development/reconcile`. Publication/artifact writes require a live matching claim token and are fenced atomically. PR reconciliation updates only an existing PR identity. Instinct keys cannot use them.

## Retrieve files, diffs and draft PR

Read `/api/jobs/JOB_UUID/publication` for `pull_request.url`, `number`, `draft`, `state`, `merged`, `head`, and current publication checkpoint. The ordinary result includes branch/head, verification checks and file counts, without the full diff.

```text
GET /api/jobs/JOB_UUID/changes?kind=execution&attempt=1&offset=0&limit=100
GET /api/jobs/JOB_UUID/diff?kind=execution&attempt=1&offset=0&limit=16000
GET /api/jobs/REVISION_UUID/diff?kind=pull_request&offset=0&limit=16000
```

Follow `next_offset` until null. File pages are at most 100 entries. Diff pages are at most 16,000 characters. Execution artifacts compare the starting commit with that execution's resulting tree, including untracked files and renames. PR artifacts compare the current base/feature merge-base with the feature head at publication. They are snapshots, not live GitHub diffs after later human base changes.

Metadata includes path, optional old path, status, additions, deletions and truncation flags. Diffs are capped at 16,000 bytes per file and 128,000 per snapshot; use GitHub for complete oversized diffs. At most 100 files and 256 KiB per changed blob are accepted. Binary, submodule, symlink, prohibited-path or obvious-secret changes block publication and withhold their content. Both old and new blobs are scanned, including deleted content. Secret detection is heuristic, not a comprehensive secret scanner. Sensitive findings require local administrator review. No absolute worker path is exposed in Phase 4 review results; `worktree_id` is a logical root-job UUID.

Generated PR bodies include title, job/root IDs, attempt, base, SHAs, Git-derived summary, cumulative files, configured check results and explicit verification limitations. GitHub drafts remain drafts. Human changes making a PR ready, closing it or merging it block future automatic revisions. The worker polls open PR status approximately every 30 seconds for dependency/status reconciliation.

## Inspect, recover and clean up

```sh
npm run development:admin -- inspect --job-id JOB_UUID
# After fixing transient Git/GitHub/database problems:
npm run development:admin -- retry --job-id JOB_UUID
# Explicit removal of a clean, fully published worktree only:
npm run development:admin -- cleanup --job-id JOB_UUID
```

These are **local administrator commands**, using `CONDUIT_ADMIN_ENV_FILE` and `CONDUIT_PROJECTS_FILE`. They are not available to Instinct. Stop the worker before retry/cleanup and restart it afterwards. Neither command silently steals locks. After SIGKILL, verify the PIDs in the worker state lock and `<storage_root>/locks/<project-id>/<root-job-id>.lock` are no longer running before removing only those lock files. Preserve worker `journal.json`, `origin`, execution JSON and worktrees. Never remove a lock belonging to a live process.

Recovery journals live at `<storage_root>/executions/<project-id>/<execution-job-id>.json`, with private mode 600. Publication checkpoints are stored before external operations where practical:

| Interrupted point                                           | Recovery behavior                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Before Codex                                                | Prepared clean state can be retried                                               |
| During Codex / ambiguous finish                             | Workspace is preserved and blocked; no blind rerun or publication                 |
| Verification fails                                          | Changes and failure metadata remain; nothing is pushed or made into a PR          |
| Verified but not committed                                  | Retry commits the recorded, inspected tree after checking the live workspace      |
| Commit succeeds before local checkpoint                     | Exact parent/tree/job marker reconcile the commit without creating another        |
| Push fails                                                  | Verified local commit remains; administrator retry resumes publication            |
| Push succeeds before database update                        | Remote head equal to the recorded commit is reconciled                            |
| PR creation response is lost                                | Look up all PR states for the branch before another creation; reuse the draft     |
| PR exists, description update or final database write fails | Retry updates the same PR and saves metadata without rerunning Codex              |
| Unexpected remote head, local commit or changed files       | Block and preserve; no force push, reset, rebase or automatic conflict resolution |
| PR closed, merged or marked ready manually                  | Record observed state and block further automated modification                    |

`retry` accepts prepared or verified/publication stages, only failed/blocked jobs, fewer than three claims, and no active execution on that branch. Earlier attempt results remain intact. A running job with a valid journal uses normal lease/journal recovery; after an expired lease the existing queue reclaims it. Unverified `executing`/`executed` state is not administratively requeued by this command. Inspect and preserve it manually, then submit a fresh independent job with corrected instructions; if there is already a published PR, a revision can proceed only once that branch is clean and publication has been reconciled. Do not silently discard prior edits to unblock a branch.

Cleanup refuses active/queued work, conflicts, any uncommitted/untracked/**ignored** content, unpublished commits, changed remote heads or PR/head mismatches. It runs ordinary `git worktree remove` with no force flag and retains the branch, PR and all database history. A dependency symlink or ignored build output must be deliberately archived/removed by an administrator before cleanup. Merged branches deleted on GitHub are conservatively refused by automated cleanup; archive locally after manual review instead. No wildcard deletion or automatic branch deletion is provided.

## Automated and opt-in integration tests

`npm test` applies every actual migration to disposable loopback PostgreSQL, tests the existing real HTTP server/worker, and tests Phase 4 against actual temporary Git repositories and a bare local remote with mocked GitHub and Codex. It covers isolation of staged/dirty checkouts, managed clones, independent branches, added/modified/deleted/renamed/untracked files, commit/push behavior, review scopes, revisions, branch locks, changed remote refs, verification failure, publication recovery, duplicate PR prevention, dependencies and disabled projects. It never reads hosted database credentials for these tests.

The disposable smoke demonstration is opt-in. Create a **dedicated disposable public or private repository** (for example `Brettberry07/conduit-phase4-test`), add topic `conduit-disposable-test`, configure the chosen local mode and authentication above, and provide registration JSON. Choose `prototype` explicitly for personal development. The repository must exactly match the explicit `CONDUIT_GITHUB_TEST_REPOSITORY` allowlist. **The smoke test always rejects `Brettberry07/conduit-poc`, even if it is later made private or given the test topic.** Choose a verification profile compatible with its fixture and policy permitting the root-level probe text file. Run the new migrated API and Mac worker first. The script registers the test project locally, submits through the configured API, waits for real Codex, checks the draft PR and diffs, submits a revision, verifies the same PR receives a new commit, and checks the default SHA did not change. It never merges or creates a repository and leaves the draft/worktree for inspection.

```sh
export CONDUIT_RUN_GITHUB_INTEGRATION=1
export CONDUIT_GITHUB_TEST_REPOSITORY=YOUR_OWNER/YOUR_DISPOSABLE_REPO
export CONDUIT_TEST_REGISTRATION_FILE=/Users/YOU/Conduit/config/test-registration.json
export SUBMITTER_KEY_FILE=/ABSOLUTE/PATH/.secrets/instinct.json
# Also export CONDUIT_API_URL, CONDUIT_PROJECTS_FILE, CONDUIT_GITHUB_SECURITY_FILE,
# and CONDUIT_ADMIN_ENV_FILE as described above. Token-file authentication is optional in prototype mode.
# Keep the configured worker running.
npm run smoke:github
```

For the initial disposable registration, use the existing registration JSON structure with a fresh fixed UUID, `repository_owner: "Brettberry07"`, `repository_name: "conduit-phase4-test"`, `default_branch: "main"`, `allowed_base_branches: ["main"]`, and managed local storage. Choose an administrator-approved verification argv such as `["/ABSOLUTE/NODE24/bin/node", "--test", "test/*.test.mjs"]` for a small dependency-free Node fixture with committed tests. Permit the root-level generated `conduit-probe-UUID.txt` via the local path policy. Do not reuse the Conduit production registration. The script registers this fixture locally before submitting the jobs.

Private evidence is written to ignored `output/phase4-UUID.json`; it includes job/revision IDs, review packages, PR URL and default-before/after SHAs. A timeout/failure is not reported as success. If a creation response is ambiguous, inspect the queue before rerunning this probe; each probe is a new independent task. `npm test` skips this integration unless the explicit opt-in flag is set. Phase 3's real Codex integration remains separately opt-in.

## Validation evidence and remaining setup

The automated suite runs the Phase 4 API/queue, actual local Git worktrees and publication/revision/recovery workflow under both `strict_bot` and `prototype`, with mocked GitHub and Codex. Authentication tests cover stored CLI login, credential-file precedence and permissions, classic/fine-grained/OAuth tokens, sanitized CLI errors, and strict audit-token behavior. Policy tests verify strict protections, prototype operation without protections, repository allowlisting and the disposable public/private guard. See `PHASE_4_IMPLEMENTATION.md` for recorded validation results and live evidence.

The existing hosted installation was explicitly upgraded on November 5, 2026: migration applied, Phase 4 API deployed, Conduit registered and the Node 24 prototype worker restarted. Authenticated `/api/projects` now returns 200. The replacement key in `.secrets/instinct-phase4.json` includes `jobs:revise`; install it in Instinct's secure secret store and send [the prepared test prompt](docs/instinct-phase4-test-prompt.md). See [the current deployment record](docs/deployment.md) for verified readiness and private local configuration paths.

The disposable smoke guard deliberately rejects the production Conduit repository. An explicitly requested normal development job against a registered Conduit repository can use its own isolated feature branch and draft PR; do not bypass the disposable smoke guard or run destructive cleanup against it.

Prototype limits: one active worker/Codex execution; fresh Codex threads; manual handling of interrupted unverified execution, conflicts and partial clones; no sandbox network/package installation or complete Conduit network/database test suite inside verification; heuristic secret scanning; bounded stored diffs; dependency/revision listings capped at 100; PR state refresh depends on the running worker. External Git/GitHub effects cannot be transactionally fenced with PostgreSQL, so local locks and head checks remain necessary.

## Active Conduit development profile

The hosted worker's local registration was broadened after the successful Instinct smoke test. `allowed_paths` is `["*"]` and `read_only_paths` is empty, allowing normal source, test, documentation and configuration/manifest changes throughout the registered repository. It no longer requires edits to the probe document.

Verification runs Next route-type generation, `tsc --noEmit --incremental false`, and automatic discovery of offline `tests/*.test.{ts,tsx,js,mjs,cjs}` files. Existing database/HTTP/Git/real-Codex integration suites and the credential subprocess harness are excluded from sandbox verification and remain part of the manually run full suite. The administrator-approved dependency directory seeds a private writable copy in each worktree. Legacy shared symlinks are migrated to copies. New packages unavailable locally need separate preparation because the sandbox remains offline.

This profile was checked in the actual network-disabled macOS sandbox with a new TypeScript source file and a newly discovered test; an intentional type error was rejected. The current policy blocks `.env`/`.env.*` files and `.ssh` directories within the project. Git inspection, workflow edits, dependency edits and generated output are allowed. Worker credentials outside the worktree, job ownership, feature-branch publication and human-controlled merges remain protected. Verification results retain bounded, redacted output. The saved `/info` worktree passed all three configured checks after this change. See [the development handoff](docs/instinct-development-prompt.md).
