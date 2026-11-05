# Phase 4 implementation handoff

Implemented in the existing `conduit-poc` checkout. The Vercel Next.js API, private Supabase PostgreSQL queue, persistent API keys, local TypeScript worker, existing simulations, Phase 3 sandbox executor, lease fencing and worker journal remain in place. Changes are uncommitted for review. The original implementation made no hosted changes. The later explicitly authorized rollout applied the Phase 4 migration, deployed the API and registered Conduit as recorded below. No GitHub settings change or PR merge was performed.

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

Set `CONDUIT_PROJECTS_FILE` to the private persistent registry. Registration validates remote identity, base refs, GitHub access, local paths and the selected local security mode. Retry is limited to intact prepared/verified publication recovery states and preserves prior attempts. Cleanup refuses active, dirty, conflicted or unpublished work and uses ordinary non-forced worktree removal; branches and history remain.

## GitHub setup and merge boundary

Two worker-local modes are supported: `strict_bot` (default) and `prototype` (explicit development-only opt-in). `CONDUIT_GITHUB_SECURITY_FILE` selects a mode through a private mode-600 JSON file. Prototype requires an exact `approved_repositories` allowlist and `acknowledge_prototype_risk: true`. Neither job nor registration payloads can select the mode. Invalid configuration fails without fallback; distributed defaults remain strict.

Strict mode retains fine-grained publisher PATs, non-admin/non-maintain identity checks, disabled auto-merge and verifiable active update restrictions with admin-only bypass plus at least one approval. The optional read-only audit token still supports hidden ruleset bypass actors.

Prototype uses `CONDUIT_GITHUB_TOKEN_FILE` when explicitly configured, otherwise it retrieves the existing local CLI login with fixed `gh auth token --hostname github.com` arguments. It accepts classic and fine-grained PATs plus CLI OAuth credentials, including the repository owner. Credential-file failures never silently switch identities. No bot, rulesets, mandatory approvals, Administration permission or policy-audit credential is required. It verifies registered/allowlisted repository identity, canonical remote, expected default branch, approved base existence, read/write access and non-archived state. It does not change repository settings.

The trusted CLI subprocess has bounded output/time, an explicit environment and sanitized errors. Codex/checks keep their isolated environment and sandbox, with added denials for CLI configuration and local Keychain storage. Tokens never enter jobs, API responses, artifacts or logs. Only trusted Git receives an ephemeral askpass credential. CLI environment token overrides are excluded; administrators can use a mode-600 token file instead.

Owner/CLI/classic credentials can retain administrative and merge permissions outside Conduit's code. Local allowlisting cannot constrain a stolen token. Prototype is for local development only. Feature-branch publication, no force push, no default/base writes, draft-only PRs, human merging, API authentication, ownership checks, worktree isolation and recovery remain intact. Mode and credential-free risk warnings appear in registration output, results and draft PRs. See `PHASE_4_TESTING.md` for exact setup and strict-mode restoration.

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
CONDUIT_GITHUB_SECURITY_FILE=/Users/YOU/Conduit/config/github-security.json \
npm run worker
```

Use official standalone Node 24 for real Codex. Rotate Instinct's key with the same principal if the existing key lacks `jobs:revise`. Send the JSON development/revision examples in `PHASE_4_TESTING.md` with bearer authentication and a UUID `Idempotency-Key`.

For the opt-in demonstration, first create/configure a public or private dedicated disposable repository and mark it with topic `conduit-disposable-test`, then:

```sh
CONDUIT_RUN_GITHUB_INTEGRATION=1 \
CONDUIT_GITHUB_TEST_REPOSITORY=YOUR_OWNER/YOUR_DISPOSABLE_REPO \
CONDUIT_TEST_REGISTRATION_FILE=/ABSOLUTE/PATH/test-registration.json \
SUBMITTER_KEY_FILE=/ABSOLUTE/PATH/.secrets/instinct.json \
npm run smoke:github
```

Export the worker/API/project/policy/admin variables above first and keep the Mac worker running. The script registers the allowlisted project, submits through the configured API, awaits real Codex, verifies draft/diffs, submits a revision, checks the same PR receives a new head, and verifies the default branch SHA remains unchanged. Evidence goes to private ignored `output/phase4-UUID.json`.

## Original Phase 4 automated validation results

On November 5, 2026:

- `npm test`: **50 tests, 48 passed, 0 failed, 2 skipped**. The skips are the opt-in Phase 3 real Codex test and Phase 4 live GitHub/Codex demonstration.
- `npm run build`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- `npm run smoke:github`: explicitly **SKIPPED**, because external integration was not configured.

Tests use the actual migrations, disposable PostgreSQL, the existing real HTTP API/admin CLI/separate worker, real temporary Git repositories and worktrees, real commits/pushes to a local bare remote, and mocked GitHub/Codex for Phase 4. Coverage includes staged/unstaged checkout preservation; managed clones; independent jobs; added/modified/deleted/renamed/untracked changes; prohibited files/secrets; permission boundaries; revisions on the same PR; database/local locks; unexpected remote changes; dependency gates; project disablement during an active lease; failed verification; lost PR responses; and recovery after verified, committed, pushed and published checkpoints, including commit-before-journal reconciliation. No mock run is presented as a real GitHub/Codex integration success.

## Prototype authentication validation

Validation on November 5, 2026:

- `CONDUIT_RUN_GITHUB_INTEGRATION=0 RUN_REAL_CODEX=0 npm test`: **83 tests; 81 passed, 0 failed, 2 skipped**. Both standard opt-in live tests were explicitly disabled.
- The Phase 4 API/queue and actual local Git workflow runs under **both modes**, including same-PR revisions, actual diffs, independent tasks, dependency gates, failed verification, checkout preservation and publication recovery.
- Authentication/policy coverage includes private configuration, strict default/no fallback, repository allowlisting, classic/fine-grained/CLI credentials, token-file precedence, sanitized CLI failures, scrubbed subprocess environments, strict audit tokens, retained strict protections and prototype operation with an unprotected base.
- Disposable smoke tests accept public/private marked repositories and retain the explicit test allowlist and production-Conduit rejection.
- `npm run build`, `npm run typecheck` and `git diff --check`: passed.

The subsequent authorized hosted rollout is complete: Phase 4 migration `20261105062426_persistent_projects.sql` and its checksum were recorded; deployment `dpl_AKTULmzcVJczkWGb8YkkF64chNyr` serves pushed commit `406557e443cd1175963b9434b6ecef3da2361eb4`; Conduit project `888e3eae-a7db-4d55-959f-34e738466191` is registered; and the worker runs from private configuration under `~/.conduit/hosted` with its existing hosted journal.

Authenticated `/api/projects` returns 200, anonymous requests return 401, and the new same-principal Instinct key includes revision scope. Hosted readiness simulation `7988bf84-d652-430b-bcb9-920cb83a1512` completed on `mac-worker`. The replacement key is delivered privately in `.secrets/instinct-phase4.json`; the old key remains active during handoff. Supabase's security advisor reports only the pre-existing intentional no-policy migration registry (RLS denies non-admin access). No schema-administrator password was recovered or reset; the connected Supabase account handled schema and registration. The saved key-admin pooler connection timed out, so the replacement key was registered through the connector using only a locally generated hash; plaintext stayed in the private local delivery file.

The user must install that key in Instinct's secure settings and send [the prepared prompt](docs/instinct-phase4-test-prompt.md). No claim of an actual request originating from Instinct is made. See `output/phase4-hosted-readiness.json` for local evidence and `docs/deployment.md` for the current deployment record.

## Real GitHub and Codex workflow proof

At the user's explicit request, a normal development job ran against `Brettberry07/conduit-poc`, using the existing local `gh auth` login, official Node 24, the real macOS Codex sandbox, an isolated local PostgreSQL/API queue and the actual worker. This did not invoke or bypass the disposable-only smoke test. It used an existing-checkout registration with separate worktree storage, changed only `docs/prototype-workflow-probe.md`, and performed no destructive cleanup or default-branch publication.

- Original job: `926f6cbe-b6f9-40bc-8e3b-0891c225019f`; verification passed and the API returned the actual file metadata and diff.
- Revision job: `88e2025e-795d-454c-bebb-09a53abf5401`; verification passed and a new commit updated the same branch and draft PR.
- Draft PR: [Conduit prototype workflow proof](https://github.com/Brettberry07/conduit-poc/pull/1). It remains open, draft and unmerged for inspection.
- Default `main` SHA before and after: `5ca98f94c35d64be4a464ff68d5960ec64d8d387` (unchanged).
- Evidence: private ignored `output/phase4-prototype-live.json`, including original/revision results and actual API diffs. The script checked results and worker logs for the GitHub credential and both API keys; none were present. Worktrees, local registry and recovery state were retained outside the checkout under `~/.conduit/phase4-local-proof-*`.

An initial locally authored verification regex was escaped incorrectly. That attempt failed verification, preserved its worktree and published nothing; a fresh job with the corrected check produced the successful evidence above. The local proof exercises the authenticated contract used by Instinct; it is not a claim that the currently deployed hosted API supports Phase 4. The existing hosted Phase 3 worker was left unchanged during the local proof; it was later stopped cleanly and replaced by the configured Phase 4 worker during the authorized rollout.

## Known limits and manual work

The current sandbox disables network; Conduit's full PostgreSQL/HTTP suite cannot run inside it unchanged. An approved sandbox-compatible verification profile supports initial contributions; run the full suite manually before merging. Dependencies must be prepared locally in an administrator-approved directory. There is one active worker per queue, fresh Codex threads, bounded diffs and heuristic secret detection. Interrupted unverified edits, conflicts, partial clones and stale locks require operator review. Revision/project listings are capped at 100; PR reconciliation depends on the running worker. There is no automatic merge, deployment, branch stacking or destructive cleanup.

The complete setup, API payloads, recovery matrix, policy details and cleanup procedure are in `PHASE_4_TESTING.md`. The disposable smoke test requires an explicit allowlist plus `conduit-disposable-test` marker and always rejects `Brettberry07/conduit-poc`.
