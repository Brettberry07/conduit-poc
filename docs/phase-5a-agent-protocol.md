# Phase 5A: dynamic agent protocol

Phase 5A adds a reusable project-management protocol for external assistants such as Instinct. Instinct researches and coordinates; Conduit validates and stores preparation context, executes existing coding jobs and enforces permissions. There is no internal PM model, event feed, scheduler, MCP server, screenshot ingestion, automatic merge or deployment. [Phase 5B](phase-5b-initiatives.md) adds persistent initiatives around the existing execution infrastructure.

## Architecture and discovery

`GET /api/agent/manifest` requires the existing `jobs:read` scope. It returns structured JSON with `Cache-Control: no-store`, using the existing authenticated API handler. No new credentials or scopes are needed. Worker keys cannot read it. `/info` remains a public descriptive capability endpoint, not the operational instruction source.

The manifest contains:

- Identity: `service`, `description`, `protocol_version`, `policy_version`, `supported_task_types`.
- `endpoints`: project discovery, submission, polling, review and revision routes.
- `capabilities`: concurrency, dependencies, offline sandbox and preparation limits.
- `preparation_contract`: mode/original-request/policy fields, generated research JSON Schema and additional source-trust/byte constraints.
- `playbook`: `role`, `constraints`, `interpret`, `modes`, `ui_research`, `submit`, `review`, `failures_and_decisions`, `source_trust`.
- `policy`: acknowledgement field, current enforcement state, legacy identification and retry behavior.

The embedded playbook is the single standing instruction source; there is no separate playbook endpoint. `src/lib/agent-protocol.ts` holds the manifest and instructions. The original Phase 5A protocol version was `5a.1`; Phase 5B extends it to `5b.1` with initiative planning/resume and generated plan/review schemas. Phase 5B used a `5b-` prefix and [Phase 5C](phase-5c-events.md) uses `5c-`. The prefix is followed by a SHA-256 hash of the complete static protocol content, including the playbook and capabilities. Operational content changes change the hash. Runtime enforcement state is excluded, so enabling enforcement does not invalidate acknowledgements. No temporary project IDs, jobs, credentials or private local paths appear in it.

Standing instructions, platform capabilities and task-specific preparation remain separate. Matching a policy hash is a client acknowledgement, not proof the client read or followed instructions. Security restrictions continue to be enforced by existing API/worker code.

## Development modes and requests

`POST /api/jobs` retains all existing development fields, project/base-branch validation, dependencies and stable UUID `Idempotency-Key` behavior. Its new fields are:

| Field              | Contract                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `development_mode` | `normal` (default) or `detailed`; preparation mode, not coding model                                          |
| `original_request` | Optional nonempty trimmed string, maximum 12,000 characters; defaults to `instructions` for new accepted jobs |
| `policy_version`   | Optional during rollout, nonempty trimmed string, maximum 100 characters; use the current manifest value      |
| `research`         | Optional strict object in normal mode; required in detailed mode                                              |

The user's original request is stored separately from actionable instructions and research. Existing pre-migration records retain null original requests and execute using their existing instructions. No queue state or accepted policy is rewritten on claim/retry.

Instinct interprets `detailed: <task>` and equivalent requests such as “research this before building it” as detailed preparation. Conduit receives the explicit structured mode; it does not parse conversation prefixes. Normal mode requires project context, clear instructions, reasonable acceptance criteria and review, without mandatory external research.

Detailed mode requires proportional external research with authoritative, current sources, project-relevant observations, practical recommendations and uncertainties. At least one source and recommendation are required. If research is unavailable or insufficient, Instinct reports the limitation and agrees a normal-mode fallback with the user or obtains the missing information. It must not invent citations. Schema validation checks structure and bounds; it cannot determine research quality or verify that a page was actually read.

For UI work the playbook covers comparable products, layout/navigation, typography, density, accessibility, responsiveness and interaction feedback. External observations belong in source findings, general recommendations in the recommendations list, user preferences in the original request, and project decisions in instructions/recommendations. No proprietary interface or assets should be copied wholesale.

### Research schema and limits

All objects reject unsupported fields. String bounds use JavaScript string length (UTF-16 code units); nonempty research strings are trimmed. Limits apply after schema normalization, with a separate streamed body cap.

| Field                              | Limit                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `objective`                        | 1–2,000 characters                                                                               |
| `summary`                          | 1–6,000 characters                                                                               |
| `recommendations`                  | 1–12 strings, each 1–1,000 characters                                                            |
| `sources`                          | 1–10 strict source objects                                                                       |
| Source `title`                     | 1–240 characters                                                                                 |
| Source `url`                       | 1–2,048 characters; valid HTTP(S), no username/password or credential-like query parameter names |
| Source `accessed_at`               | Valid calendar date, `YYYY-MM-DD`                                                                |
| Source `relevance`                 | 1–1,000 characters                                                                               |
| Source `findings`                  | 1–2,000 characters; paraphrased source-specific observations                                     |
| `uncertainties`                    | Optional, defaults to `[]`; at most 8 strings of 1–1,000 characters                              |
| Entire normalized research         | At most 49,152 UTF-8 bytes of compact JSON                                                       |
| Development creation/revision body | At most 98,304 streamed bytes                                                                    |

Simulation and fixed `codex_task` submissions retain their 32,768-byte limit; report/artifact limits are unchanged. The API returns 400 `Invalid request` for malformed schemas, invalid research/URLs, recognizable credentials, unsupported fields and exceeded limits, without echoing content. Recognizable token formats, private keys, Bearer values, credential assignments and credential-bearing URLs in job content are rejected. Arbitrary secrets cannot be detected reliably: the assistant must never include credentials, including novel formats or sensitive URL parameters. Source URLs are references only; neither API nor worker fetches them.

### Normal example

Use the approved origin and securely injected Bearer header for every authenticated call. Fetch the manifest and select the intended enabled project from `GET /api/projects`; placeholders below must be replaced from those reads. Save the exact body and a UUID before sending it.

```http
POST /api/jobs
Authorization: Bearer <securely injected Instinct key>
Content-Type: application/json
Idempotency-Key: <saved UUID for this logical job>

{
  "task": "development",
  "project_id": "<selected project UUID>",
  "title": "Add job search",
  "original_request": "Add a search filter to Conduit's job board.",
  "instructions": "Add a title search filter using existing board components. Preserve existing status filters and job detail access.",
  "acceptance_criteria": "Search matches titles without case sensitivity; clearing search restores results; keyboard and mobile use work; configured checks pass.",
  "development_mode": "normal",
  "policy_version": "<manifest policy_version>"
}
```

### Detailed example

This example illustrates provenance, not a claim that Instinct has performed research. The assistant must actually inspect sources, record its access date and adapt findings to the repository before submission.

```http
POST /api/jobs
Authorization: Bearer <securely injected Instinct key>
Content-Type: application/json
Idempotency-Key: <another saved UUID>

{
  "task": "development",
  "project_id": "<selected project UUID>",
  "title": "Improve job-state readability",
  "original_request": "detailed: Improve Conduit's dashboard UI. Research good developer-dashboard UX patterns first.",
  "instructions": "Inspect the current board. Improve state scanning with consistent text labels and spacing, preserving filters, detail access and keyboard behavior. Keep this task scoped to status presentation.",
  "acceptance_criteria": "Status is understandable without color alone; controls remain keyboard accessible; narrow layouts preserve access to job details; configured checks pass.",
  "development_mode": "detailed",
  "policy_version": "<manifest policy_version>",
  "research": {
    "objective": "Identify accessible job-state presentation requirements.",
    "summary": "Status cues should remain understandable without depending only on color.",
    "recommendations": ["Pair existing state colors with explicit text labels."],
    "sources": [
      {
        "title": "Web Content Accessibility Guidelines 2.2",
        "url": "https://www.w3.org/TR/WCAG22/",
        "accessed_at": "2026-11-06",
        "relevance": "Accessibility requirements for status presentation.",
        "findings": "Success Criterion 1.4.1 addresses conveying information through means beyond color alone."
      }
    ],
    "uncertainties": ["Inspect the existing components before choosing label placement."]
  }
}
```

A broader dashboard redesign would require additional relevant product and interaction research. A source link alone is not evidence that a claim is correct.

## Persistence, execution and source trust

The additive migration `20261106221029_agent_protocol.sql` adds `development_mode`, `original_request`, `policy_version`, `accepted_policy_version` and `research` to `orchestrator.jobs`. Existing records default to normal mode with null research/policy/original-request fields. Research is JSONB, bounded at the database level with allowance for JSONB formatting overhead; the API enforces the tighter compact-byte/schema limits. No new tables, grants, scopes, ownership policies or hosted resources are introduced. Existing private-schema RLS and runtime grants remain in effect.

Owner-filtered job list/detail and revision reads expose preparation context. Worker claims already return job columns and retain the same accepted context across lease retries and recovery journals. Reads by another principal return no job data. The GUI remains unchanged.

Before Codex starts, `worker/development/context.ts` formats original intent, task instructions, acceptance criteria, mode, research objective/summary, recommendations, individual source citations/findings and uncertainties into readable sections. Individual research strings are quoted to keep newlines inside reference values. The final section reiterates worker restrictions. This formatting is not a prompt-injection security boundary: research remains untrusted, and sandbox/credential/publication restrictions are enforced by the existing execution infrastructure. Codex must evaluate recommendations against the worktree, never blindly execute external commands, and never treat citations as proof. Network access remains disabled. Git worktrees, locks, verification, draft publication and recovery semantics are unchanged.

## Policy rollout and retries

Default: leave `CONDUIT_ENFORCE_POLICY_VERSION` unset or set to `false`. Unversioned new development jobs and revisions remain accepted; their null `policy_version` identifies them as legacy. The read-only `accepted_policy_version` separately records the server policy at acceptance for every newly accepted development job/revision, including legacy submissions. Pre-migration records retain null acceptance versions. Supplied stale versions are rejected even during rollout with HTTP 409 and an instruction to retrieve `GET /api/agent/manifest`.

After Instinct is updated, set `CONDUIT_ENFORCE_POLICY_VERSION=true` in the API environment. Exactly `true` activates enforcement for newly accepted development jobs and revisions. Missing versions then receive HTTP 400 with the manifest retrieval instruction. Current versions are accepted. Simulation jobs, fixed sandbox jobs and worker operations do not require a version. Setting the option back to false restores legacy acceptance.

Idempotency lookup and content comparison occur before current-policy checks, project/dependency revalidation or draft-PR eligibility checks. An identical previously accepted request returns the existing job with HTTP 201 even if its policy is now stale, missing, enforcement was activated or the project was subsequently disabled. Acknowledgement-version differences alone do not conflict or rewrite the recorded version; changes to instructions, mode, original request, research or other existing content fields return the existing 409 conflict behavior. Retry the exact accepted request whenever possible. No policy check is performed during claims, so queued jobs remain executable under their accepted context and existing safety checks.

## Review and same-PR revisions

Retrieve the terminal job, actual verification checks, changed files, paginated readable diffs, draft publication metadata and execution history. Follow `next_offset` until null. Use both execution and `kind=pull_request` views where relevant. Distinguish passed checks from failed or not-run checks and from unverified acceptance criteria. Detailed-mode review also considers research recommendations, subordinate to the user's request.

`POST /api/jobs/{id}/revisions` retains `jobs:revise`, a new stable UUID and existing open-draft-PR eligibility. It accepts `instructions`, `acceptance_criteria` and the same four preparation fields. Omitted mode and research inherit from the addressed job; supplied research replaces the entire brief. Null research is not supported as a clearing operation. The revision's original request defaults to its own revision instructions. It records its own policy acknowledgement rather than inheriting the parent's. Detailed effective mode requires research, either supplied or inherited. Routine revisions reuse the root branch and PR.

The PM playbook recommends at most two automated revisions per root task, checking `/revisions` history across resumptions, before escalating. This is guidance, not a new server-side limit. Failures, blocked dependencies, missing research, speculative revisions and recovery-required states must be reported honestly. No automatic merge or deployment is implemented.

## Local verification and manual rollout

Run from a trusted prepared checkout, outside the offline worker sandbox:

```sh
npx tsx --test tests/agent-protocol.test.ts tests/development-flow.test.ts
npm test
npm run build
npm run typecheck
```

Unit tests cover deterministic versions, permissions, strict research validation and worker prompt formatting. Disposable PostgreSQL integration tests run the migration under existing runtime permissions and cover mode defaults, research storage/owner isolation, stale/missing/current policy, accepted retries across a simulated policy release, queued jobs, research-preserving lease recovery and same-PR revision inheritance/update. Existing Git, publication, recovery, HTTP and worker tests remain part of the full suite. Real Codex and live GitHub tests retain their opt-in prerequisites.

No hosted migration or deployment is performed by this implementation. After explicit owner approval:

1. Apply the additive migration using the existing administrator migration runbook; preserve historical migration checksums.
2. Update/restart the trusted local worker from this release so detailed research reaches Codex. Drain active executions through the existing graceful shutdown/recovery procedure first.
3. Deploy the API with version enforcement off. An old API will reject the new fields; a new API with an old worker would store research without delivering it to Codex, so finish both upgrades before adoption.
4. Verify authenticated manifest access and legacy submission compatibility. Give Instinct [the short standing instruction](instinct-standing-instruction.md) once through its durable project-rule mechanism.
5. From Instinct itself, test a normal request and a real researched detailed request, then retrieve evidence, request a justified revision if needed, and confirm the same PR/branch. Record actual HTTP responses and verification evidence without secrets.
6. Once Instinct reliably sends the current policy version, enable enforcement and verify missing/stale/current versions plus an accepted historical retry. Keep existing keys and scopes; no worker/GitHub credentials belong in Instinct.

Real Instinct manifest adoption, actual research behavior and end-to-end live Codex delivery remain external acceptance tests. API/unit/integration success alone does not establish those behaviors.
