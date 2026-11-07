# Phase 5C durable activity and checkpoints

Conduit records meaningful changes to jobs, publications, initiatives, and PM assessments. An authorized client such as Instinct reads an ordered feed, retrieves current evidence when needed, and saves a durable checkpoint in Conduit. Instinct chooses when to check and which authorized PM actions to take. Scheduled monitoring is a separate phase.

## Event storage and ordering

The additive migration `20261107173313_phase_5c_events.sql` creates three tables in the private `orchestrator` schema.

| Table             | Contents                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`          | Stable UUID, owner principal, owner-scoped bigint cursor, event type, schema version, recording time, related project/initiative/task/job/root IDs, and JSONB data limited to 2,048 bytes in its text representation |
| `event_cursors`   | Transactional last allocated cursor for each owner                                                                                                                                                                   |
| `event_consumers` | Owner and logical consumer name, last acknowledged cursor, creation time, and last advancement time                                                                                                                  |

Deferred row triggers on `jobs`, `development_tasks`, `initiatives`, and `initiative_reviews` append events in the same transaction as the source changes. They compare old and new state. Activation inserts and links its jobs before the deferred triggers run, so job creation events contain their initiative and task references. A worker publication write attaches the job holding the lease. Older API binaries can attribute publication state transitions to the running family member during rollout. Reconciliation records PR observations against the root job.

Each transaction finishes its source writes and acquires a short advisory gate on its first event append during deferred trigger execution. The gate precedes all owner counter locks and lasts until commit. Bulk dependency and lease sweeps can touch multiple owners, so the shared gate prevents owner counter lock inversions even when rows are visited in different orders. Deferred producers read source relationships without row locks. Event references are snapshots of IDs and add no foreign-key locks on source records. This serializes event allocation at commit, while job execution, lease renewals, HTTP reads, and GitHub work retain their existing concurrency. Application transactions leave these constraints deferred.

For each owner, the counter increments and the event inserts inside the source transaction. An allocated cursor cannot become visible after a higher committed cursor for that owner. Another transaction can finish its source writes sooner and commit first, in which case it receives the earlier cursor. A rollback discards both the source write and the allocated cursor. A reader sees only committed events, with order defined by the cursor. All events in one transaction become visible together. `occurred_at` records when Conduit appended the event. Use the cursor for ordering and use `data.observed_at` for PR observations. See PostgreSQL's [constraint trigger documentation](https://www.postgresql.org/docs/current/sql-createtrigger.html) and [locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html).

Event history starts when the migration commits, including transitions from compatible Phase 5B binaries during rollout. Existing rows are preserved and earlier activity is absent. Prototype retention is indefinite. The owner/cursor unique index and job and initiative history indexes bound ordinary reads.

## Event types

IDs outside `data` point to current records. Optional references are null when they do not apply. A revision has its own `job_id` and the original `root_job_id`. Non-development jobs have no root or project. Data contains allowlisted metadata. Titles, instructions, results, errors, research, review bodies, diffs, worker paths, credentials, and claim tokens stay outside the feed.

| Event                                                                                     | Recorded transition and data                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initiative.created`                                                                      | Draft saved. Status and plan version.                                                                                                                           |
| `initiative.plan_updated`                                                                 | New accepted draft version. Previous and current plan versions.                                                                                                 |
| `initiative.activated`                                                                    | Draft activated. Previous/current status and plan version. The same transaction emits creation events for the linked jobs.                                      |
| `initiative.paused`, `initiative.resumed`, `initiative.completed`, `initiative.cancelled` | Lifecycle transition. Previous/current status and plan version.                                                                                                 |
| `initiative.review_recorded`                                                              | Accepted PM assessment. Review ID and outcome. Retrieve it with `GET /api/initiatives/{id}/reviews?review_id={review_id}`.                                      |
| `job.created`                                                                             | Accepted standalone job, initiative task, or revision. Initial status, task type, and revision flag.                                                            |
| `job.requeued`                                                                            | Operator queued a failed or blocked job for recovery. Previous/current status and prior attempt number.                                                         |
| `job.claimed`, `job.retried`                                                              | First claim or lease recovery into a later attempt. Attempt number and initial phase when available.                                                            |
| `job.phase_changed`                                                                       | Distinct reported execution phase. Attempt number and current/previous recognized phase.                                                                        |
| `job.completed`, `job.failed`, `job.blocked`                                              | Terminal state. Attempt number, result availability, and verification status when recognized. Retrieve the job for the reason and evidence.                     |
| `job.dependencies_resolved`                                                               | Waiting job became queued after all prerequisite merges were observed.                                                                                          |
| `publication.verified`, `publication.pushed`                                              | Recorded verification and push milestones. Attempt when known and pushed head SHA when available. A recovered push may confirm an already matching remote head. |
| `pull_request.created`                                                                    | Conduit first recorded a PR association, including discovery after an interrupted create request.                                                               |
| `pull_request.updated`                                                                    | Recorded a meaningful change to an open PR or the worker recorded a successful same-PR revision publication.                                                    |
| `pull_request.merged_observed`, `pull_request.closed_observed`                            | Conduit observed a merge or unmerged closure through the existing GitHub workflow.                                                                              |

PR events carry the PR number, observation time when available, state, merged/draft flags, and head SHA when available. Retrieve the job's `/publication` for the current PR URL and details. Observation time is when Conduit recorded GitHub's response and can lag GitHub activity. The worker polls the existing open-PR set. A stored merge survives a stale open response. Dependencies still wait for the queue to reconcile readiness.

An identical accepted request or terminal report does not add an event. Unchanged reconciliation can refresh observation freshness without emitting activity. Identical phases, progress ticks, artifacts, and heartbeats leave the stream alone. Verified and pushed milestones are deduplicated for each known job attempt. A later recovery attempt can produce its own events.

## Read the feed

`GET /api/agent/events?after=1041&limit=50` requires `jobs:read`. Feed pages return ascending cursors from the authenticated principal. `after` defaults to `"0"`, the beginning of the recorded stream. Use canonical unsigned decimal strings, with no leading zeros except for zero and no values above the PostgreSQL signed bigint maximum. A nonzero `after` must exist in this principal's stream. Keep cursors as strings in JavaScript. The limit defaults to 50 and accepts integers from 1 through 100.

```json
{
  "events": [
    {
      "id": "3205b6aa-923c-4ac4-a064-85a8bc612a70",
      "cursor": "1042",
      "type": "job.completed",
      "schema_version": 1,
      "occurred_at": "2026-11-07T16:42:00.000Z",
      "project_id": "5a120088-d69f-4761-858b-a980459c13ed",
      "initiative_id": "74a9b22e-cc16-424b-8f76-9ea70fc9e04e",
      "task_key": "agent-interface",
      "job_id": "d81c8350-b9c9-4a9b-82e0-136a9d1d6e3e",
      "root_job_id": "d81c8350-b9c9-4a9b-82e0-136a9d1d6e3e",
      "data": {
        "attempt": 1,
        "verification_status": "passed",
        "result_available": true
      }
    }
  ],
  "next_after": "1042",
  "has_more": false
}
```

`next_after` is the last returned cursor and stays at the supplied cursor for an empty page. It is a page position. Save it as the checkpoint only after processing the entire page. `has_more` reports what was visible at read time. New events may follow a short or empty page. All event and checkpoint responses set `Cache-Control: no-store`.

### Filtered history

Use `GET /api/agent/events?initiative_id={uuid}` or `?job_id={uuid}` for newest-first history. The job filter matches the exact job ID. Root-level GitHub reconciliation appears on the root job, and revision publication appears on the revision. Each filter accepts `limit` and the exclusive `before` event UUID returned by the same filtered view. History returns `next_before` and `has_more`. History uses event UUIDs as page positions and omits checkpoint cursors. A consumer advances by processing the unfiltered owner feed.

`GET /api/initiatives/{id}/resume` includes `activity.latest_cursor` and `activity.history_url`. The cursor describes the latest event for that initiative in the same read snapshot as the rest of resume. It is null when no activity was recorded. The current initiative, job, and review endpoints provide authoritative detail.

## Consumer checkpoints and replay

1. Choose a stable name such as `instinct-primary`. Names start with a lowercase ASCII letter or digit, contain up to 64 lowercase ASCII letters, digits, hyphens, or underscores, and are scoped to the owner.
2. Read `GET /api/agent/event-consumers/instinct-primary` with `jobs:read`. A new name returns a virtual `acknowledged_cursor` of `"0"` and null timestamps. The first successful acknowledgement creates the row. To register at zero, send zero for both fields.
3. Fetch the unfiltered feed after the acknowledged cursor. Process in cursor order. Read the job, initiative resume, diff, publication, or review when a decision depends on current evidence.
4. Persist follow-up work or decisions. For a review, revision, or other idempotent mutation, reuse the same UUID and body for the same action across retries. Check for a newer job or assessment before requesting another revision.
5. Send `POST /api/agent/event-consumers/instinct-primary/ack` with `jobs:revise` and the highest contiguously processed cursor.

```json
{ "cursor": "1042", "expected_previous_cursor": "1041" }
```

```json
{
  "consumer": {
    "name": "instinct-primary",
    "acknowledged_cursor": "1042",
    "created_at": "2026-11-07T16:00:00.000Z",
    "acknowledged_at": "2026-11-07T16:43:00.000Z"
  }
}
```

Conduit locks the named checkpoint and compares the expected position before advancing. An invalid, unknown, future, or backward target is rejected. A stale expected cursor receives 409 if the target differs from the current checkpoint. Repeating an acknowledgement that already reached its target returns the existing row and timestamp. If another monitor has since advanced farther, reload after the 409. Acknowledgement records the client's claim of contiguous processing. Conduit cannot inspect external decisions or verify that a client acted on every event.

Delivery is at least once. If the consumer stops after recording a review but before acknowledging, the next session reads the same event again. Check current records and use the original idempotency key to recover the accepted action. Events created while handling an older page receive later cursors and remain available. A consumer can stop partway through a page by acknowledging only its processed prefix.

### First use and recovery

1. Read or register the checkpoint at zero. List owned initiatives and jobs, follow their pagination, and inspect current state through initiative resume and relevant job endpoints. Save or reconcile unresolved work from these records, including jobs that predate the stream.
2. Replay from zero, even if the snapshot reads took time. This covers transitions that happened before or during those reads. Use events as change signals and consult current state before acting, since the snapshot can already include newer changes.
3. Persist decisions and acknowledge each processed prefix. Later conversations or interrupted monitors resume from the same named checkpoint.

Running jobs can report while their initiative is paused. New claims still respect the pause. Lease recovery and publication recovery use the existing worker fences and journals. After a timeout, use the same checkpoint request body or read the saved checkpoint. After a long interruption, repeat until caught up.

### PM actions

The authenticated manifest uses protocol `5c.1` and a new `5c-<sha256>` policy version. Fetch the manifest before preparing new work after rollout. Accepted identical retries remain valid.

For `job.completed`, inspect the job, verification, changed-file metadata, actual diff, publication state, and any linked initiative acceptance criteria. Record a PM assessment when warranted. A justified same-PR revision uses the existing limit of two autonomous revisions per root task and a stable idempotency key.

For `job.failed` or `job.blocked`, read the current failure and escalate actionable blockers or human decisions. Resolve the existing job or initiative with its supported operations.

For `pull_request.merged_observed`, read the initiative's current state and let the queue manage dependency readiness.

For `initiative.review_recorded`, retrieve the assessment if it informs an outstanding decision. Reviews already recorded or acted on by this consumer are informational. Use current revision history and a stable action key to prevent replay or an assessment event from generating another revision. An assessment is a PM record. GitHub approval, merge, and deployment remain human actions.

## Permissions and console

`jobs:read` allows reading owned events and checkpoints. `jobs:revise` allows acknowledging an owned checkpoint. Viewers and linked console sessions can read. Worker credentials cause events through their existing claim, report, and publication routes. Event reads and acknowledgements are available to submitter identities with the required scopes. Private-schema RLS and grants preserve the trusted server boundary. The runtime has event read access and no direct event or counter write access. Internal trigger functions append activity using explicit grants and a fixed search path. Browser clients reach the tables through Conduit's authorized HTTP routes.

The job detail sheet shows up to 20 recent recorded events, oldest first, with times and matching GitHub links. It refreshes while the sheet is open. Current-state polling continues on the board and Active view. Initiative history is available through the API.

## Local validation and hosted rollout

Run on a trusted non-root local machine with Node.js 24.x.

```sh
npm ci
node_modules/.bin/tsx --test tests/events.test.ts
npm test
npm run typecheck
npm run build
```

The event tests start disposable PostgreSQL and use the restricted runtime role. They exercise initiative activation, concurrent worker requests, publication and reconciliation, page and checkpoint resumption, review replay, owner isolation, rollback, concurrent checkpoint updates, and cursors above JavaScript's safe integer range. The ordering test lets one transaction write first and commit second, then forces an early allocation to verify another transaction waits and a reader cannot cross the uncommitted cursor. The existing HTTP/worker and development-flow tests cover local Next.js, worker restart and retry paths, real Git worktrees and pushes, and a simulated GitHub API for draft PR recovery and same-PR revision. Live Codex and GitHub probes have separate opt-in setup.

1. Validate the migration locally and run the database and concurrency tests.
2. Verify the existing job, initiative, and draft PR paths with the full suite.
3. After explicit approval, apply the migration using the [hosted migration runbook](deployment.md). Existing API and worker clients can keep operating while the migration adds the triggers and nullable publication attribution field. Older API binaries do not require event tables for reads. Apply the migration before deploying the Phase 5C API, which reads these tables.
4. Deploy the matching API and restart the local worker from the matching checkout using its existing state directory. The worker HTTP request contract is compatible with the older release.
5. Confirm an authorized test transition emits an event, then reconcile current state and initialize the Instinct checkpoint.
6. Resume from the checkpoint after another transition and verify that only later events are returned.

For an application rollback, leave the additive schema installed so event history and checkpoints are preserved. The migration and local tests establish implementation behavior. Hosted migration, deployment, and live Instinct acceptance require their own evidence.
