# Phase 5B: persistent development initiatives

Conduit now stores a multi-task objective, its versioned plan, task dependencies, linked development jobs and PM assessments. An external assistant can reconstruct its work from an initiative ID after losing conversation context. Instinct still supplies planning and judgment. The existing queue, worker, worktrees and same-PR revision workflow execute code.

This is an API implementation. The authorized November 6, 2026 rollout applied the hosted schema migrations described below. Vercel deployment, live Instinct acceptance, Claude execution and automatic GitHub merging are outside this implementation verification.

## Architecture and database

The additive migration is `supabase/migrations/20261106230808_initiatives.sql`. It adds five private `orchestrator` tables:

| Table                      | Durable information                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initiatives`              | UUID, owner principal, registered project, creation idempotency content, current structured plan/version, lifecycle, activation receipt, creation/update/completion times and completion summary |
| `initiative_tasks`         | Stable `(initiative_id, task_key)`, owner/project, task specification, display order, optional unique root development job link and timestamps                                                   |
| `initiative_dependencies`  | Explicit task-key edges; composite foreign keys keep both ends in the same initiative; primary key rejects duplicate edges; check rejects self-edges                                             |
| `initiative_plan_versions` | Append-only accepted full snapshots, version, initiating owner, optional explanation and timestamp                                                                                               |
| `initiative_reviews`       | Append-only PM assessment, initiating owner, examined root/job/revision, request UUID and timestamp                                                                                              |

A task key identifies a task within its initiative; no additional task UUID is needed. Existing keys persist for retained tasks across draft edits. Removing a draft task removes its current row, while prior snapshots retain it. Job links are created only on activation. An activated plan cannot be changed or extended in this phase.

Composite foreign keys keep task, project and job ownership consistent and prevent attaching an assessment to a job outside the linked task's root family. `development_tasks` remains the source for branches, publications and PR observations. `jobs` and `execution_attempts` remain the sources for execution and verification. New indexes cover owned initiative listing, root job history, dependency targets and assessment history. No existing jobs or execution history are rewritten.

All five tables enable RLS and revoke PUBLIC privileges. The runtime receives only the required table operations; plan versions and reviews grant no update/delete. As with the existing queue, private-schema RLS admits the trusted `conduit_api` server role, while the authenticated API enforces principal ownership. This is not an `auth.uid()`/PostgREST authorization design. Supabase anon/authenticated roles receive no new grants or exposed schema. No administrative HTTP route is added.

The migration also adds `development_tasks.pull_request_observed_at`. Publication/reconciliation writes this timestamp only when a PR observation is supplied. This is the server receipt time of a worker-supplied observation, not a GitHub modification time or a guarantee the worker just fetched it. Responses label this timestamp semantics explicitly. Existing records retain null because their actual observation time is unknown. Local head/phase changes do not refresh GitHub observation time.

## Lifecycle and progress

| Lifecycle   | Meaning                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `draft`     | Plan saved; no jobs created                                                                  |
| `active`    | Plan submitted; queue may dispatch tasks                                                     |
| `paused`    | New claims, revisions' claims and expired-lease retries are gated; live workers may finish   |
| `completed` | Explicit PM completion after task PRs are observed merged and overall acceptance is reviewed |
| `cancelled` | Terminal abandonment; history and existing jobs remain                                       |

Activation moves draft to active. Lifecycle PATCH supports active→paused, paused→active, draft/active/paused→cancelled, and active/paused→completed. Lifecycle writes require `expected_status`; conflicting updates return 409. Completion additionally requires a nonempty `completion_summary`, all tasks in the derived merged stage, and no latest `needs_decision` assessments. Conduit stores the PM's acceptance conclusion; it does not formally prove acceptance criteria or impersonate human approval. Completed/cancelled initiatives cannot be reactivated and reject new code revisions; previously accepted identical revision retries still return their records.

Pause/cancel and claims use the existing claim advisory lock, so a successful pause fences subsequent claims. Running Codex processes are not terminated and keep the existing lease/report/publication rules. Standalone jobs and the four-agent scheduler retain their behavior. A disabled registered project is rejected at new activation/resume-to-active and continues to be fenced by the existing claim/publication checks. Reads/history remain available. An administrator changing project availability after validation cannot bypass worker fences.

Derived task `state` is `not_started`, `waiting_dependencies`, `queued`, `running`, `failed`, `awaiting_review` or `merged`. A later queued/running/failed revision takes precedence over an earlier published PR. `publication_stage` separately distinguishes `not_published`, `draft_pr_published`, `awaiting_review_or_merge` and `merged_observed`. `integration_state` becomes `integrated_pm_confirmed` only for merged tasks in an explicitly completed initiative. A completed execution without an observed open/merged PR requires inspection; it is not automatically integrated.

The response includes current job phase/status, verification status, root/latest job IDs, revision count, PR/head information, dependency reasons, last known update time and evidence links. No independently editable task execution status exists. `dispatch` explains lifecycle/project restrictions independently of execution progress. Job update time is derived from available claim/completion/publication timestamps; this phase does not introduce an event feed.

## Plan schema and limits

POST accepts `{ "plan": { ... }, "policy_version": "<manifest value>" }`.

| Plan field                    | Contract                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `project_id`                  | One enabled administrator-registered project UUID; cannot change on draft revision    |
| `base_branch`                 | Optional approved branch; omission resolves the current project default at activation |
| `title`, `description`        | Nonempty trimmed title ≤200 characters; description ≤4,000, default empty             |
| `original_request`            | Nonempty trimmed original user text ≤12,000 characters                                |
| `goal`, `acceptance_criteria` | Nonempty trimmed strings ≤4,000 characters each                                       |
| `development_mode`            | `normal` (default) or `detailed`; initiative preparation context                      |
| `research`                    | Optional valid Phase 5A structured brief, retained on the plan                        |
| `tasks`                       | Ordered array of 1–20 strict task objects                                             |

Each task has `task_key`, `title`, `description`, `instructions`, `acceptance_criteria`, `development_mode`, optional `research` and `dependencies`. Keys match `^[a-z][a-z0-9-]{0,63}$`. Instructions are nonempty trimmed text ≤12,000 characters; task acceptance criteria are nonempty trimmed text ≤4,000. Title/description bounds match the plan. Array order controls display, not execution priority. No dependencies are inferred.

Every edge must reference a different existing task in the same plan. Duplicate keys/edges, missing tasks, self-edges and cycles fail validation. A dependency path may contain at most 10 tasks. Create/edit bodies are streamed with a 524,288-byte limit; normalized research remains ≤49,152 UTF-8 bytes, and each activated job must fit the existing 98,304-byte development body limit. Unsupported fields, recognizable credentials and invalid research provenance are rejected. Drafts can be refined by replacing the entire plan with `expected_plan_version` and optional `explanation`; accepted versions increment and snapshots remain readable.

Research is deliberately per task. A detailed initiative does not force tasks into detailed mode. Detailed tasks require their own valid brief, including at least one source and recommendation. Normal tasks do not inherit initiative research. Select only relevant sources/findings for each detailed task; preserve actual access dates, findings, relevance and the Phase 5A source-trust rules. Invalid/missing detailed-task research is rejected at draft validation and revalidated during activation; Conduit never fabricates sources or fetches their URLs.

## API and authorization

Every route uses the existing Bearer authentication/principal mapping and `Cache-Control: no-store`.

| Method | Endpoint                        | Scope and behavior                                                                                             |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/initiatives`              | `jobs:read`; owned summaries; `limit` 1–100 (default 50), UUID `before` cursor from `next_before`              |
| POST   | `/api/initiatives`              | `jobs:create`; draft + initial snapshot; stable UUID `Idempotency-Key`; 201                                    |
| GET    | `/api/initiatives/:id`          | `jobs:read`; complete plan and derived progress                                                                |
| PATCH  | `/api/initiatives/:id`          | `jobs:revise`; lifecycle with `expected_status`, `status`, optional completion summary                         |
| GET    | `/api/initiatives/:id/plan`     | `jobs:read`; current plan/version and task→root-job mapping; `?version=N` returns accepted historical snapshot |
| PATCH  | `/api/initiatives/:id/plan`     | `jobs:revise`; full draft replacement with `expected_plan_version`, `plan`, optional `explanation`             |
| POST   | `/api/initiatives/:id/activate` | `jobs:create`; UUID idempotency key, expected plan version and policy acknowledgement; 201 with job mapping    |
| GET    | `/api/initiatives/:id/resume`   | `jobs:read`; consolidated compact PM context                                                                   |
| GET    | `/api/initiatives/:id/reviews`  | `jobs:read`; complete assessment history, `limit` 1–100 and UUID `before` cursor from `next_before`            |
| POST   | `/api/initiatives/:id/reviews`  | `jobs:revise`; append assessment with its own UUID idempotency key; 201                                        |

Other principals receive 404 for an owned initiative's details, plans, historical snapshots, reviews or resume. Viewer credentials read only their mapped principal. Worker credentials cannot read or write PM routes. Indirect review job references must be in the linked owned root family.

An identical accepted create/activate/review retry returns the existing record. Content conflicts return 409. Keys are scoped by principal and operation. Creation compares the normalized original plan, even if the current draft was edited later. Activation compares the accepted plan version. As in Phase 5A, a changed `policy_version` alone does not conflict, and accepted retries are returned before checking current policy or project availability. New draft creation and activation enforce current/missing policy rules; draft edits and PM assessments do not create development jobs.

The first successful activation key is retained. Concurrent activation calls serialize on the initiative row; identical saved-key retries return the same mapping. A different key after activation returns 409 with instructions to read existing job links. It never creates another set of jobs. A failed transaction leaves the initiative unactivated, with no partial jobs or task links; retry the saved request after correcting the failure. PATCH is optimistic, not a create operation: after a lost response, reread current version/status before retrying.

Malformed schemas/bodies return 400; invalid projects/research return 400; stale policy/version, idempotency conflicts and unsafe lifecycle/plan edits return 409. Missing/insufficient credentials retain 401/403. A transaction failure returns a generic 500 without submitted secrets or database details.

## Example: draft, revise and activate

This example describes future Claude support. Saving/reading it does not implement Claude or start processes. Use authorized project discovery and the current manifest first. Generate and retain a different UUID for each logical creation, activation or assessment, along with its exact body. The following is a draft creation body:

```json
{
  "policy_version": "<GET /api/agent/manifest policy_version>",
  "plan": {
    "project_id": "11111111-1111-4111-8111-111111111111",
    "title": "Add Claude Code support to Conduit",
    "description": "Preserve existing Codex execution and recovery.",
    "original_request": "Add Claude Code support to Conduit. Figure out what needs to change and handle the implementation.",
    "goal": "Allow an explicitly selected coding provider.",
    "acceptance_criteria": "Codex and Claude both use the existing queue, verification, worktree, publication and recovery boundaries.",
    "development_mode": "normal",
    "tasks": [
      {
        "task_key": "agent-interface",
        "title": "Define a shared coding-agent execution interface",
        "instructions": "Extract the existing Codex execution contract without changing behavior. Keep CLI-specific configuration outside the shared adapter.",
        "acceptance_criteria": "Existing Codex execution, failure and recovery checks pass.",
        "development_mode": "normal",
        "dependencies": []
      },
      {
        "task_key": "claude-configuration",
        "title": "Validate Claude installation and configuration",
        "instructions": "Add isolated provider configuration validation and installation detection without editing the shared execution adapter. Document required local setup.",
        "acceptance_criteria": "Missing or invalid configuration produces actionable errors without exposing credentials.",
        "development_mode": "normal",
        "dependencies": []
      },
      {
        "task_key": "claude-provider",
        "title": "Implement provider integration and selection",
        "instructions": "Use the shared interface and validated configuration to add explicit provider selection. Preserve Codex defaults and the existing queue.",
        "acceptance_criteria": "Provider selection and failure handling are verified without bypassing worker restrictions.",
        "development_mode": "normal",
        "dependencies": ["agent-interface", "claude-configuration"]
      },
      {
        "task_key": "integration-tests",
        "title": "Verify both providers through the existing worker",
        "instructions": "Exercise both providers, failures, retries and same-PR revisions with disposable repositories and mocked execution; document live acceptance separately.",
        "acceptance_criteria": "Configured checks cover provider selection, publication and recovery with no automatic merge.",
        "development_mode": "normal",
        "dependencies": ["claude-provider"]
      }
    ]
  }
}
```

Send it to `POST /api/initiatives` with JSON content type, secure Bearer authentication and the saved creation UUID in `Idempotency-Key`. Record `initiative.id`. No jobs exist yet. For a planning-only user request, stop at a reviewed draft.

Read `GET /api/initiatives/<id>/plan`. To refine the draft, PATCH that endpoint with `{ "expected_plan_version": 1, "plan": <complete revised plan>, "explanation": "Clarify adapter boundaries" }`. Retain keys for existing tasks. Read version 1 with `?version=1` and the new current version with the plain endpoint. A conflicting edit receives 409.

When implementation is authorized, send:

```http
POST /api/initiatives/<id>/activate
Authorization: Bearer <securely injected key>
Content-Type: application/json
Idempotency-Key: <saved activation UUID>

{
  "expected_plan_version": 2,
  "policy_version": "<current manifest policy_version>"
}
```

Response (UUID symbols below represent actual returned job UUIDs):

```json
{
  "initiative_id": "<initiative UUID>",
  "jobs": [
    { "task_key": "agent-interface", "root_job_id": "<A>" },
    { "task_key": "claude-configuration", "root_job_id": "<B>" },
    { "task_key": "claude-provider", "root_job_id": "<C>" },
    { "task_key": "integration-tests", "root_job_id": "<D>" }
  ]
}
```

Activation preassigns A–D before inserting any jobs. Job C receives `dependency_job_ids=[A,B]`; D receives `[C]`. A/B enter the existing queue; C/D begin in `waiting_dependencies`. All rows, branch registrations, links and activation receipt commit together. The shared `insertDevelopmentRoot` service preserves standalone branch naming, preparation, ownership, policy and job creation semantics. The worker receives its ordinary job contract, without a second initiative scheduler.

A/B publishing draft PRs does not unlock C. Only reconciled GitHub merge observations unlock dependencies through the existing queue. Independently branched edits can conflict; the planner must sequence shared-file changes when needed. No automatic merge, rebase, branch stacking or cherry-picking exists.

## PM reviews and decisions

After inspecting actual changes, diffs, checks and executions, POST an assessment:

```json
{
  "task_key": "agent-interface",
  "job_id": "<examined root job or revision UUID>",
  "observed_head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": "ready_for_human_review",
  "summary": "Adapter behavior and configured checks were inspected. Human PR review is still required.",
  "criteria_evaluated": ["Existing Codex behavior", "Failure propagation"],
  "evidence_references": [
    "/api/jobs/<job UUID>/diff",
    "/api/jobs/<job UUID>/executions"
  ],
  "outstanding_concerns": []
}
```

Outcomes are `ready_for_human_review`, `revision_needed`, `blocked` and `needs_decision`. Summary ≤2,000 characters; 1–20 criteria ≤1,000 each; at most 20 evidence references ≤2,048 each and 20 concerns ≤1,000 each. Observed SHA is optional, lowercase hexadecimal, 40–64 characters. Missing SHA is conservatively stale/unverifiable. Assessment bodies are capped at 65,536 bytes. Evidence is an assistant-supplied reference, not automatically fetched or verified.

Assessments remain append-only and distinct from GitHub human reviews. An examined SHA differing from the local published head or a known observed PR head, or a later linked job/revision, makes the assessment stale. This also catches changes observed from outside Conduit. Unknown observation freshness remains visible; a non-stale assessment does not establish a live GitHub guarantee. Actual code revisions still use `POST /api/jobs/:id/revisions` and reuse the branch/PR.

The latest assessment for each task supersedes earlier assessments for current decision state. A latest `needs_decision` appears in `unresolved_decisions`, including its age/staleness. After obtaining and applying the user's decision, append a new assessment explaining the resolution. History remains available; this is a small PM record system, not a collaborative decision tracker. The playbook retains the default limit of two autonomous revision attempts per root before escalation, checked against durable revision history.

## Resume without conversation memory

An assistant can list owned initiatives, select the matching objective and call `GET /api/initiatives/<id>/resume`. A separate conversation needs only the ID and authorized API access. The response includes the original request, goal/acceptance criteria, lifecycle/version, current task titles/acceptance criteria/modes, dependencies and root/latest job IDs; derived execution/verification/publication/merge state; failures; assessment summaries; unresolved decisions; and suggested actions.

Illustrative response, shortened to one task:

```json
{
  "initiative": {
    "id": "<initiative UUID>",
    "title": "Add Claude Code support to Conduit",
    "original_request": "Add Claude Code support to Conduit. Figure out what needs to change and handle the implementation.",
    "goal": "Allow an explicitly selected coding provider.",
    "status": "active",
    "plan_version": 2,
    "plan_url": "/api/initiatives/<id>/plan"
  },
  "dispatch": { "enabled": true, "reason": null },
  "progress": {
    "total": 4,
    "not_started": 0,
    "waiting_dependencies": 2,
    "queued": 0,
    "running": 0,
    "failed": 0,
    "awaiting_review": 2,
    "merged": 0
  },
  "tasks": [
    {
      "task_key": "claude-provider",
      "dependencies": ["agent-interface", "claude-configuration"],
      "root_job_id": "<C>",
      "latest_job_id": "<C>",
      "job_status": "waiting_dependencies",
      "state": "waiting_dependencies",
      "verification_status": "not_run",
      "blocking_reason": "Waiting for prerequisite PRs to merge on the approved base branch",
      "pr_observation": {
        "source": "unavailable",
        "observed_at": null,
        "live": false
      },
      "links": {
        "job": "/api/jobs/<C>",
        "changes": "/api/jobs/<C>/changes",
        "diff": "/api/jobs/<C>/diff",
        "publication": "/api/jobs/<C>/publication",
        "executions": "/api/jobs/<C>/executions",
        "revisions": "/api/jobs/<C>/revisions"
      }
    }
  ],
  "outstanding_failures": [],
  "unresolved_decisions": [],
  "next_actions": [
    { "type": "review_pr", "task_key": "agent-interface" },
    { "type": "wait_for_dependency", "task_key": "claude-provider" }
  ],
  "review_history": {
    "included_per_task": 3,
    "summaries_only": true,
    "more": "/api/initiatives/<id>/reviews"
  }
}
```

Resume does not fetch GitHub. `live=false` and the recorded observation time must accompany any merge-state report. Null time means unknown freshness; no observation is manufactured for legacy data. Configured check success is separate from publication, human review, observed merge and explicit overall completion.

Reads use a consistent PostgreSQL snapshot. Resume omits complete diffs, execution outputs, instructions and research bodies. It includes the latest three bounded assessment summaries per task; fetch paginated `/reviews` for full criteria, evidence, concerns and older history. Follow linked job endpoints for evidence and `/plan` for implementation/research context. Suggested actions are deterministic hints, not autonomous planning, scheduling or authorization.

## Manifest and standing instruction

`src/lib/agent-protocol.ts` remains the single operational PM instruction source. Protocol `5b.1` extends Phase 5A with initiative endpoints, generated plan/review JSON schemas, bounds, planning versus execution authorization, deliberate dependency/research choices, durable resume, lifecycle and assessment guidance. The static policy hash now uses `5b-<sha256>` and changes with all operational content. Existing normal/detailed jobs, provenance, policy records, accepted idempotent retries, research delivery and same-PR revision semantics are preserved. Old policy acknowledgements are stale for new work; accepted identical retries remain valid.

Keep Instinct's permanent addition short:

> For substantial multi-task requests, create a persistent Conduit initiative, activate it when implementation is authorized, and resume from its saved ID and API state. Use a single development job for small changes. Never assume unmerged PRs are available to dependent tasks. Retrieve the dynamic manifest for detailed operational guidance.

The full updated standing instruction is in `docs/instinct-standing-instruction.md`. No second playbook or internal planning model is introduced.

## Verification and acceptance scope

`tests/initiatives.test.ts` and `tests/helpers/initiatives.ts` exercise the Claude-support example with disposable embedded PostgreSQL and the real restricted runtime role. All API requests use real authentication, transactions, queue claims and existing publication/report/revision/reconciliation routes. Coding and GitHub observations are mocked; these tests do not invoke Claude, claim live hosted acceptance, or merge code.

Coverage includes bounded/invalid DAGs, task schema/research errors, ownership and viewer/worker scopes, exact/different-content idempotency, concurrent draft edits, historical snapshots, stale/new policy checks, disabled projects, atomic activation rollback after the first root insert, correct UUID/dependency mapping, queued independent tasks, publication versus observed merge, pause preserving running reports, dependency failure propagation, same-PR revision linkage, stale assessments, decision resolution, pagination and ID-only resume. The HTTP suite separately exercises draft creation, exported PATCH routing, activation retries, consolidated resume and lifecycle changes through a real Next.js server. Existing Git/worktree, recovery, four-agent, simulation and Phase 5A integration tests remain in the complete suite.

Run locally:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Real Codex/GitHub probes remain separately opt-in. Do not claim multi-day Instinct or hosted GitHub acceptance until performed with authorization. Local verification recorded on November 6, 2026:

- `npm test`: 127 tests reported, 124 passed, 3 skipped, 0 failures. The skips are the existing opt-in real sandbox/Codex and hosted GitHub probes.
- `npm run build`: passed with Next.js 16.4.5, including TypeScript and route generation.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- The Supabase CLI advisor command was attempted against a separate disposable embedded PostgreSQL instance. It could not complete because the CLI required TLS while the embedded fixture serves local plaintext connections, including when given local `sslmode=disable`. This initial local attempt did not run hosted advisors. Local tests directly verify RLS, grants, owner/family foreign keys and append-only permissions. Hosted advisor results from the later authorized rollout are recorded below.

These are local test outcomes, not live installation health or multi-day Instinct acceptance. After authorized migration, run the installation's Supabase security/performance advisors separately.

## Deployment and recovery

1. Review the migration and take the installation's normal database backup. Use the existing dedicated administrator migration workflow, not a runtime/worker/Instinct credential. The migration preserves hosted job/credential mappings.
2. With explicit hosted authorization, run the repository's existing migration runner against the verified project: `npm run db:migrate -- --project-ref <dedicated project ref>`. For the verified local development database use `npm run db:migrate -- --local`. Never point local tests at hosted credentials.
3. Deploy this API release only after the additive migration. The new claim query requires initiative tables. The existing Phase 5A worker remains compatible; no worker code/configuration change, new provider, local slot manager or credentials are required.
4. Fetch the deployed authenticated manifest, verify `5b.1` and its current policy hash, then exercise a planning-only draft before any authorized activation. Update Instinct's short standing instruction and refresh its policy acknowledgement for new work.
5. Separately authorize and run hosted activation/worker/GitHub acceptance. PR merges and deployment of generated changes still require their own authorization.

On network loss, reuse the saved UUID and exact create/activate/review body. Do not generate replacement jobs to recover a lost response. Read `/plan` to recover the complete mapping after an already-activated conflict; read `/resume` for next actions. After a failed activation, database rollback leaves a draft and no linked execution records. A stale policy requires a new manifest for unaccepted work; an optimistic edit conflict requires rereading the accepted version. Worker leases, retries, recovery journals and same-PR revisions remain the existing recovery mechanism.

Pause before maintenance if new dispatch must stop. Cancellation/completion retain queued history and prevent new claims; they do not terminate a running process. Avoid rolling back to an older API that lacks lifecycle claim gates while any initiative is paused/cancelled; quiesce workers first. The additive database tables may remain during rollback; do not delete preserved initiative/job history as a recovery technique.

## Authorized hosted schema rollout — November 6, 2026

At the user's explicit request, the existing `conduit-poc` Supabase project was verified against the repository and both missing additive migrations were applied through the connected Supabase migration tool:

| Local migration                     | Supabase migration history      |
| ----------------------------------- | ------------------------------- |
| `20261106221029_agent_protocol.sql` | `20261106233136_agent_protocol` |
| `20261106230808_initiatives.sql`    | `20261106233144_initiatives`    |

Phase 5A was not yet installed on the hosted database and was applied first as the required preparation-column prerequisite. Both applications took the existing migration advisory lock and inserted the exact local filename/SHA-256 into `conduit_meta.schema_migrations` in the same migration operation. All nine local migration checksums now match the hosted ledger; the normal local migration runner will not replay these files. The Supabase tool's history versions reflect actual application time and therefore differ from local creation filenames.

Post-migration queries verified all five initiative tables, enabled RLS, runtime SELECT grants, no anon/authenticated SELECT grants, all five Phase 5A preparation columns, and the PR observation timestamp column. Counts before and after application remained 28 jobs, 13 development tasks, 8 API keys, 1 Auth/principal mapping and 1 registered project. No coding jobs or initiative fixtures were created in the hosted database.

Hosted security/performance advisors were run after application. Security results matched the preflight: the private migration ledger intentionally has RLS without a runtime policy, and the existing [leaked-password protection setting remains disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No new security warning appeared. Performance advisors reported informational [foreign-key index coverage notices](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) for six initiative foreign keys and the existing jobs project foreign key, plus newly unused indexes before initiative traffic exists. Some references already have narrower selective indexes; these notices are retained for workload-based follow-up rather than adding redundant indexes during rollout.

This verifies the hosted schema, not the new API deployment or live Instinct/worker acceptance. Push-to-main and Vercel deployment are separate actions; no Vercel deployment command or repository-setting change was part of the schema application.

## Known limitations

- One registered repository per initiative; no active-plan extension or rewriting submitted job instructions/dependencies.
- No UI redesign, event feed, schedule, webhook/email notifications, internal PM model, additional coding provider, shell-task API, automatic merge/deploy or branch stacking.
- PR state is the most recently stored observation; GitHub remains authoritative. Existing records can have unknown freshness. No new polling/monitoring service is added.
- PM assessments and completion summaries are conclusions from an assistant, not human approvals or formal acceptance proofs. Decisions use the latest assessment per task; richer decision workflows are deferred.
- Resume intentionally summarizes review history and links full evidence. No cross-conversation memory is needed, but the assistant must retain/discover the initiative ID and have valid scoped credentials.
- Splitting work does not guarantee conflict-free integration. The planner must choose appropriate independent tasks and sequence shared-file changes.
