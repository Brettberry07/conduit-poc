# Phase 4 implementation handoff

Implemented in the existing `conduit-poc` checkout. The Vercel Next.js API, private Supabase PostgreSQL queue, persistent API keys, local TypeScript worker, existing simulations, Phase 3 sandbox executor, lease fencing and worker journal remain in place. Changes are uncommitted for review. No cloud migration, deployment, GitHub repository mutation or PR merge was performed during implementation.

## Architecture changes

Administrator-approved projects now have a cloud record and separate private worker-local configuration. Development jobs use persistent linked Git worktrees and unique feature branches. Managed projects use a persistent bare clone; existing repositories retain their checkout, branch, staged index and dirty files.

The trusted worker runs Codex and configured checks in the credential-isolated macOS sandbox, captures changes from Git, inspects old/new blobs for prohibited content, creates a commit from the inspected tree, pushes only the approved feature branch, and creates/updates a draft PR. Execution changes and cumulative PR changes are stored separately as structured metadata and bounded diffs. Verification failure preserves local changes and prevents publication.

Revisions are separate jobs on the same root branch/PR. Branch coordination is enforced by the queue's task-row locking, unique active-root index, local branch lock and expected remote head checks. Dependencies reference existing owned root jobs in the same project/base and wait for an observed GitHub merge. Publication journals reconcile interrupted commits, pushes, PR creation and database reporting without repeating Codex after verified execution.

## Migration

`supabase/migrations/20261105062426_persistent_projects.sql` adds:

- Private RLS-enabled `projects`, `development_tasks`, `execution_attempts`, `change_artifacts` tables.
- Development/revision project and root IDs, approved base, dependencies and running phase on jobs.
- Dependency waiting/blocked statuses, active-branch coordination and retained execution attempt history.
- `jobs:revise` scope support without revoking or expanding existing keys.
- Runtime read-only access to project records; registration remains administrator-only.

Apply through the existing migration CLI using a schema-administrator connection:

```sh
CONDUIT_ADMIN_ENV_FILE=.env.schema-admin.local \
  npm run db:migrate -- --project-ref YOUR_20_CHARACTER_PROJECT_REF
```

The key-administrator login cannot apply migrations or register projects. For isolated local setup use the local administrator connection and `--local`.

## API additions

Existing authenticated endpoints remain. New read routes use `jobs:read`; revisions require `jobs:revise`:

```text
GET  /api/projects
GET  /api/projects/:id
POST /api/jobs                         task: "development"
GET  /api/jobs/:id/publication
GET  /api/jobs/:id/executions
GET  /api/jobs/:id/changes
GET  /api/jobs/:id/diff
GET  /api/jobs/:id/revisions
POST /api/jobs/:id/revisions
```

Diffs support `kind=execution|pull_request`, `attempt`, `offset`, `limit` and return `next_offset`. Worker-only publication/artifact endpoints retain live claim-token fencing; reconciliation can update only the stored PR identity. Submitters receive no worker paths, claim tokens or GitHub credentials. There is no registration, merge or mark-ready HTTP operation.

## Local administrator commands

```sh
npm run project -- add --config /ABSOLUTE/PATH/project-registration.json
npm run project -- list
npm run project -- inspect PROJECT_UUID
npm run project -- disable PROJECT_UUID
npm run development:admin -- inspect --job-id JOB_UUID
npm run development:admin -- retry --job-id JOB_UUID
npm run development:admin -- cleanup --job-id JOB_UUID
```

Set `CONDUIT_PROJECTS_FILE` to the private persistent registry. Registration validates remote identity, base refs, GitHub access, local paths and human-only merge policy. Retry is limited to intact prepared/verified publication recovery states and preserves prior attempts. Cleanup refuses active, dirty, conflicted or unpublished work and uses ordinary non-forced worktree removal; branches and history remain.

## GitHub setup and merge boundary

Use an existing dedicated bot with ordinary repository Write access and a fine-grained token restricted to selected repositories, Contents read/write, Pull requests read/write and Metadata read. Store it in a private mode-600 `CONDUIT_GITHUB_TOKEN_FILE`, outside project/worktree storage.

GitHub hides ruleset bypass actors from accounts without ruleset write access. Where necessary, configure a separate mode-600 `CONDUIT_GITHUB_POLICY_TOKEN_FILE` from a human administrator account with **only Administration read and Metadata read**. It supplies read-only ruleset inspection; code prevents using it on other routes or mutations. It must have no Contents write, Pull requests write or Administration write grants. It is never supplied to Git, Codex or verification.

Disable auto-merge. Protect every approved base branch with an active update restriction allowing only repository administrators to bypass, and require PR review. The bot must have no admin, maintain or bypass role. Registration/publication fail closed when this cannot be verified. This repository permission/ruleset boundary prevents the bot credential from updating protected bases even after approval; draft status and prompt instructions are additional controls. See the runbook for supported rulesets and GitHub documentation links.

## Commands to start and test

Install and validate:

```sh
npm ci
npm test
npm run build
npm run typecheck
```

After the migration, existing Vercel deployment workflow, project registration, local Codex login and dependency preparation:

```sh
CONDUIT_API_URL=https://YOUR-PROJECT.vercel.app \
WORKER_KEY_FILE=/ABSOLUTE/PATH/.secrets/worker.json \
WORKER_STATE_DIR=/ABSOLUTE/PATH/.worker/hosted-phase4 \
CONDUIT_PROJECTS_FILE=/Users/YOU/Conduit/config/projects.json \
CONDUIT_GITHUB_TOKEN_FILE=/Users/YOU/Conduit/secrets/github-token \
CONDUIT_GITHUB_POLICY_TOKEN_FILE=/Users/YOU/Conduit/secrets/github-policy-read-token \
npm run worker
```

Use official standalone Node 24 for real Codex. Rotate Instinct's key with the same principal if the existing key lacks `jobs:revise`. Send the JSON development/revision examples in `PHASE_4_TESTING.md` with bearer authentication and a UUID `Idempotency-Key`.

For the opt-in demonstration, first create/configure a private dedicated disposable repository and mark it with topic `conduit-disposable-test`, then:

```sh
CONDUIT_RUN_GITHUB_INTEGRATION=1 \
CONDUIT_GITHUB_TEST_REPOSITORY=YOUR_OWNER/YOUR_PRIVATE_DISPOSABLE_REPO \
CONDUIT_TEST_REGISTRATION_FILE=/ABSOLUTE/PATH/test-registration.json \
SUBMITTER_KEY_FILE=/ABSOLUTE/PATH/.secrets/instinct.json \
npm run smoke:github
```

Export the worker/API/project/policy/admin variables above first and keep the Mac worker running. The script registers the allowlisted project, submits through the configured API, awaits real Codex, verifies draft/diffs, submits a revision, checks the same PR receives a new head, and verifies the default branch SHA remains unchanged. Evidence goes to private ignored `output/phase4-UUID.json`.

## Automated validation results

On November 5, 2026:

- `npm test`: **50 tests, 48 passed, 0 failed, 2 skipped**. The skips are the opt-in Phase 3 real Codex test and Phase 4 live GitHub/Codex demonstration.
- `npm run build`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- `npm run smoke:github`: explicitly **SKIPPED**, because external integration was not configured.

Tests use the actual migrations, disposable PostgreSQL, the existing real HTTP API/admin CLI/separate worker, real temporary Git repositories and worktrees, real commits/pushes to a local bare remote, and mocked GitHub/Codex for Phase 4. Coverage includes staged/unstaged checkout preservation; managed clones; independent jobs; added/modified/deleted/renamed/untracked changes; prohibited files/secrets; permission boundaries; revisions on the same PR; database/local locks; unexpected remote changes; dependency gates; project disablement during an active lease; failed verification; lost PR responses; and recovery after verified, committed, pushed and published checkpoints, including commit-before-journal reconciliation. No mock run is presented as a real GitHub/Codex integration success.

## Known limits and manual work

The live demonstration remains unverified: this session had no explicit opt-in, dedicated test registration or worker GitHub token. Cloud rollout, repository protections and credentials remain manual setup.

The current sandbox disables network; Conduit's full PostgreSQL/HTTP test suite cannot run inside it unchanged. An approved sandbox-compatible verification profile can support initial Conduit contributions, but run the full suite manually before merging. Dependencies must be prepared locally in an administrator-approved directory. The implementation supports one active local worker, fine-grained dedicated-bot tokens, fresh Codex threads, strict admin-only ruleset bypass policies, bounded stored diffs and heuristic secret detection. Interrupted unverified edits, conflicts, partial clones and stale process locks require deliberate operator review. Revision/project listings are capped at 100; PR reconciliation depends on the running worker. There is no automatic merge, deployment, branch stacking or destructive cleanup.

The complete setup, API payloads, recovery matrix, policy details and safe cleanup procedure are in `PHASE_4_TESTING.md`.
