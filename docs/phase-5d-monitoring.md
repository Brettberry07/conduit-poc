# Phase 5D scheduled PM monitoring

Instinct runs the recurring checks, evaluates evidence, and messages the user. Conduit stores jobs, initiatives, PM assessments, event history, and consumer checkpoints. The authenticated `GET /api/agent/manifest` is the standing policy. It publishes monitoring contract version 1, the profiles, and the current playbook under protocol `5d.1`. Its `5d-<sha256>` policy version covers the monitoring instructions as well as the existing development instructions.

## Monitoring endpoint

`GET /api/agent/monitor?consumer=instinct-primary` requires `jobs:read` and a submitter identity. A viewer for the same principal can read it. The required consumer name follows the [Phase 5C name rules](phase-5c-events.md#consumer-checkpoints-and-replay). The name is configurable. The endpoint accepts one `consumer` query parameter and sets `Cache-Control: no-store`.

```json
{
  "server_time": "2026-11-07T18:00:00.000Z",
  "consumer": {
    "name": "instinct-primary",
    "acknowledged_cursor": "1042",
    "created_at": "2026-11-07T16:00:00.000Z",
    "acknowledged_at": "2026-11-07T17:00:00.000Z"
  },
  "activity": {
    "events": [],
    "next_after": "1042",
    "has_more": false
  },
  "overview": {
    "active_initiatives": 2,
    "running_jobs": 1,
    "waiting_jobs": 3,
    "queued_for_execution": 1,
    "failed_jobs": 0,
    "awaiting_review": 1
  },
  "attention": [
    {
      "condition_id": "review_pr:d81c8350-b9c9-4a9b-82e0-136a9d1d6e3e",
      "type": "review_pr",
      "initiative_id": "74a9b22e-cc16-424b-8f76-9ea70fc9e04e",
      "task_key": "agent-interface",
      "job_id": "d81c8350-b9c9-4a9b-82e0-136a9d1d6e3e",
      "reason": "Draft PR awaiting review",
      "details_url": "/api/jobs/d81c8350-b9c9-4a9b-82e0-136a9d1d6e3e"
    }
  ],
  "attention_has_more": false,
  "worker_readiness": {
    "available_workers": 1,
    "unavailable_workers": 0,
    "last_seen_at": "2026-11-07T17:59:56.000Z",
    "details_url": "/api/workers"
  }
}
```

The checkpoint, first feed page, and current state come from a repeatable-read, read-only PostgreSQL transaction. The GET leaves checkpoints, heartbeats, jobs, and credential usage timestamps untouched. A new consumer returns cursor `"0"` and null timestamps.

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity`           | Up to 50 committed owner events using the existing Phase 5C response, ordering, and string cursors. Continue with `GET /api/agent/events?after=<next_after>&limit=50`.                                                                                                                                                                                                                                                                                                                   |
| `overview`           | Active initiative count plus owned standalone jobs and jobs in active or paused initiatives. Running and waiting counts include physical revisions and expired running leases. Waiting includes queued and dependency-waiting jobs. `queued_for_execution` counts queued jobs outside paused initiatives on enabled projects where applicable. It is an estimate of demand, since branch and capacity fences still apply. Failure and open-PR counts describe the latest job per family. |
| `attention`          | At most 20 current signals. It lists decisions first, then failures, recovery and publication issues, then open PRs and dependency waits. A condition ID is stable for the same signal type and job or decision record. Standalone signals have null initiative and task references.                                                                                                                                                                                                     |
| `attention_has_more` | Additional current signals exist. Reconcile them using owned initiative and job listings and their detail endpoints. The attention list has no cursor.                                                                                                                                                                                                                                                                                                                                   |
| `worker_readiness`   | Shared worker-pool aggregates from the existing worker heartbeat records. `last_seen_at` is the latest heartbeat across registered workers, or null before the first heartbeat. Use `GET /api/workers` for individual timestamps.                                                                                                                                                                                                                                                        |

`needs_decision` points to the latest assessment for a task that still asks for a decision, including a stale assessment if it remains unresolved. `review_pr` means the latest completed development job has a recorded open, unmerged PR. Read existing assessments to determine whether PM review is still needed. `inspect_failure`, `inspect_publication`, and `pr_closed` call for checking the latest job or its publication. `dependency_blocked` identifies an unmerged prerequisite that failed, was blocked, or closed without merging. `wait_for_dependency` can also mean the queue has yet to reconcile an observed merge. `recovery_pending` identifies an expired lease on a job still marked running.

The response omits diffs, job instructions, research, logs, worker identities, and claim tokens. Use initiative `/resume`, `/plan`, and `/reviews` and job `/changes`, `/diff`, `/publication`, `/executions`, and `/revisions` for evidence. A PR can change after the last recorded GitHub observation. Confirm the current head directly in GitHub when authorized and available.

## Running a scheduled check

Use one Instinct task per owner with an explicit profile and stable consumer name. Start hourly. Use 15-minute checks only after the user explicitly agrees and Instinct confirms support. Idle checks can run hourly or less often. Scheduling and messaging depend on Instinct and are best effort. Opening the Conduit dashboard does not start or change a scheduled check.

1. Fetch the current manifest. Read the monitor snapshot, or fetch the checkpoint and unfiltered event feed separately.
2. On first use, reconcile owned active and paused initiatives and relevant standalone jobs using the paginated listings and their details. Include work that predates Phase 5C. Save reconciliation progress across runs if necessary. Replay from the saved cursor, starting at zero for a new consumer. Summarize current outstanding issues and avoid sending individual messages about historical transitions.
3. Process events in order. Budget up to five pages of 50 and two PR reviews per ordinary check. Treat routine claims and phases as digest material. Investigate completions, revisions, and verification before acting. Prioritize confirmed blockers and human decisions. Reconcile current conditions even when activity is empty.
4. Complete any required durable PM action or decision, and save intended messages privately. Acknowledge only the highest contiguous processed prefix via `POST /api/agent/event-consumers/{name}/ack` with `{"cursor":"1042","expected_previous_cursor":"1041"}`. This requires `jobs:revise` in either profile. A viewer can inspect but cannot advance a durable checkpoint or write an assessment.
5. Send a concise update when warranted. Group related changes by initiative, link PRs when available, and distinguish actions taken from user decisions. Leave remaining work for the next run.

### Profiles and review authority

- `watch_only` reads activity and evidence, reports meaningful developments, and can acknowledge processed events with appropriate credentials. It submits no jobs, PM assessments, or revisions.
- `pm_autonomous` can also record Phase 5B assessments and request justified same-PR revisions within implementation scope the user already authorized. The profile is configured in Instinct and grants no API permissions.

For a completion or revision, read the original request and acceptance criteria, compare the changes with the initiative goal, and retrieve both execution and cumulative PR artifacts where relevant. Follow `next_offset` for diffs and changed-file metadata. Distinguish passed, failed, skipped, and unexecuted checks. Record the examined head and evidence gaps in any linked initiative assessment. Standalone jobs use the same evidence and revision APIs and have no Phase 5B assessment record.

Check the latest job, PM reviews, and revision history immediately before requesting a revision. Use the existing open draft PR and preserve its commits. The suggested limit is two autonomous revisions per root task. Escalate unresolved findings after the budget is spent or if authorization, eligibility, or evidence is unclear. An assessment confers no GitHub approval. Neither profile permits automatic merges, deployments, repository deletion, or credential changes.

### Worker readiness

A heartbeat is considered recent for 15 seconds. A recent worker may be busy, and a stale heartbeat identifies a gap in observations without explaining the state of the Mac. To report persistent unavailability, require work that needs capacity, zero recent workers, and at least five minutes since the first qualifying observation confirmed by a later check. When a prior heartbeat exists, it must also be at least five minutes old. Keep an eye on expired leases and existing recovery state. Paused work and ordinary dependency waits alone do not justify a capacity alert.

### Replay and low-noise messaging

Use private durable Instinct state scoped to the authenticated owner and scheduled task. Store the exact request body and UUID for each pending review or revision before sending it. For duplicate or overlapping executions, prefer a scheduler that prevents overlap, or serialize writes and messaging with a shared durable lock. If exclusivity cannot be established, defer writes and sends. On timeout, inspect current reviews and revision history and retry the exact request as needed. On a checkpoint conflict, reload the same consumer and reconcile. If an acknowledgement response is lost, read the checkpoint or retry the same body. Stop on authentication or permission failures and resume with the same consumer when restored.

Use event IDs to deduplicate event-derived messages. For a persistent condition, store its stable condition ID, first-seen time, and a fingerprint of the material state last reported. Use one stable capacity condition key per consumer for a continuing worker outage. Ignore observation timestamps and routine progress when deciding if a warning materially changed. Reset on confirmed resolution so a later recurrence can be reported. Absence from a truncated snapshot does not confirm resolution.

Write intended messages to the private journal before acknowledging their events. Reconcile pending sends after interruption, even when the next event page is empty. Store send outcomes separately and reuse external message idempotency keys where supported. If Instinct cannot verify an ambiguous send, avoid automatically resending the same update. The checkpoint records event processing only. External delivery and a Conduit database write are separate operations. Conduit has no message ledger or delivery receipt.

## Installation and verification

Use Node 24.x and the [local setup guide](operator-guide.md#local-setup-and-full-verification) for a manual local run. The automated suites start disposable PostgreSQL and the HTTP suite starts an isolated Next.js server.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

After explicit approval, apply `20261107184033_phase_5d_monitor_auth.sql` through the [hosted migration runbook](deployment.md) before deploying the matching API. The migration adds the restricted read-only credential lookup and does not alter the Phase 5C event tables, triggers, or checkpoints. The monitoring path leaves `last_used_at` unchanged. Other API-key requests still record usage.

With the updated API accessible from Instinct, follow [Instinct monitor setup](instinct-monitor-setup.md). External acceptance requires observing at least two actual scheduled executions, confirming checkpoint advancement after real activity, and receiving an unsolicited meaningful update. Local tests cover HTTP authorization, PostgreSQL isolation and replay, and real Git workflows with a simulated GitHub API. They do not establish Instinct scheduling, private-state persistence, or message delivery.

## Limits

The snapshot is bounded and does not perform live GitHub calls or run queue recovery. Event history begins with Phase 5C, and the snapshot includes only current signals. Conduit does not verify the completeness of a client's acknowledgement or enforce the advisory revision budget. Instinct must confirm recurring authenticated API access, durable private state across runs, a way to prevent concurrent PM mutations and sends, and proactive messaging before relying on scheduled monitoring.
