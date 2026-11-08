# Claude executor compatibility design

Status: proposal, docs only, 2026-11-07. No behavior or dependency changes. Brett wants staged Claude support using his own subscription; he currently has no subscription available for testing. No API usage, purchase, signup or live model call is authorized. Credential, architecture and server changes require his explicit approval first. Conduit manages commits and draft-PR publication; this session must not perform those operations.

## Evidence and source limitations

Repository evidence: [Codex executor](../worker/codex.ts), [trusted session](../worker/codex-session.mjs), [development executor](../worker/development/executor.ts), [development lifecycle](../worker/development/run.ts), [runner/journals](../worker/runner.ts), [Git/security policy](../worker/development/git.ts), [change inspection](../worker/development/changes.ts), and [development migration](../supabase/migrations/20261105062426_persistent_projects.sql). `package.json` pins `@openai/codex-sdk` 0.166.0 and contains no Claude SDK dependency.

Required primary references:

| Official source | Implementation review must resolve |
| --- | --- |
| [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | Query/result types, cancellation, environment, settings discovery, tool-permission precedence, sandbox options and binary provenance |
| [Headless mode](https://code.claude.com/docs/en/headless) | Scripted execution, non-bare login and bare-mode authentication restrictions |
| [Sandboxing](https://code.claude.com/docs/en/sandboxing) | Seatbelt shell boundary, network proxy, file-tool exclusions and fail-closed configuration |
| [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | Ordinary subscription use, hosted unmodified binary permission and SDK/integration authentication restrictions |
| [Settings](https://code.claude.com/docs/en/settings), [permissions](https://code.claude.com/docs/en/permissions) | Exact rule grammar, precedence and discovery controls |

**Primary-source verification is incomplete.** Fetching URLs/network access is prohibited for this task. No local Claude documentation or research connector was available. Links identify review targets, not proof of current contents. Claude-specific constraints below come from the task instructions, not independently retrieved quotations. Exact SDK options and subscription eligibility for this integration must be resolved from primary text before implementation; do not silently substitute API-key authentication.

## 1. Executor parity and insertion point

Recommendation for owner approval: add a parallel Claude session adapter first, retaining the existing development lifecycle, then extract a shared agent-executor interface after both providers have contract coverage. Avoid duplicating `development/run.ts` or its publication state machine. A narrow provider-selection seam in `executeWorktree` is sufficient initially.

`worker/claude-session.mjs` would sit beside `worker/codex-session.mjs`, driving the official `@anthropic-ai/claude-agent-sdk`, which bundles the **unmodified official Claude Code binary**. Verify and pin package/binary provenance before adding a dependency. Never patch the binary, intercept OAuth, replace its transport or route subscription credentials through an alternate endpoint.

| Existing boundary | Claude parity requirement |
| --- | --- |
| `executeCodex(job, renew, stopping, rememberAttempt)` | This is the disposable TypeScript fixture path, distinct from real development. A Claude fixture adapter must preserve bounded snapshots and verification; it does not itself deliver development support. |
| `executeWorktree(workspace, repository, config, job, renew, stopping, phase, remember, previousFailures)` | Retain worktree policy, dependency preparation, development/retry context and callbacks. Select provider-specific security setup and child after validated routing. |
| Private attempt directory and `remember` | Journal a validated provider-tagged attempt before credential creation or SDK startup. |
| Detached trusted Node child, IPC `{workspace, timeout, instructions}` | Same input semantics, approved executable and working directory; parent owns termination. Never accept an arbitrary caller-selected binary/config path. |
| Codex thread, completion and error events | Normalize Claude session ID and SDK terminal result into session/success/failure events. Assistant text or exit zero alone is insufficient; require a successful terminal result and successful child exit. Validate actual discriminants against the pinned SDK. |
| Bounded IPC summaries; no raw tool output, prompts or reasoning | Allowlist event fields, redact before truncation, and omit raw SDK messages/content blocks/tool inputs. |
| `Execution = { thread_id?, checks }` | Preserve callers; introduce versioned provider/session metadata in journals/results. A Claude session is not a resumable Codex thread. |
| `run.ts` locks, changes and publication checkpoints | Reuse existing lifecycle safeguards. The controller verifies/publishes; the model receives no GitHub publishing credentials. |

Rationale: timeout, cleanup and `sandboxCommand` currently live in the Codex module, while Claude permissions, sandbox guarantees and result streams differ. An immediate general abstraction risks hiding those differences and destabilizing Codex recovery. Share existing provider-independent lifecycle behavior first; later extract session execution, normalized outcomes, cancellation and cleanup once tests establish their common contract. This is a proposed architecture, not approval to implement it.

## 2. Sandbox translation and limits

Current development explicitly requires macOS and Node 24. `developmentSandboxConfig` grants workspace/scratch writes, read-only Git metadata, denies controller/storage/repository/login and credential paths, and disables network. The trusted supervisor retains model transport outside the tool boundary. Verification uses `sandboxCommand`, invoking `codex sandbox -P conduit -C <workspace> -- ...`; its tested macOS boundary is `sandbox-exec`/Seatbelt. A preflight checks denied credential reads before execution.

Claude Code's built-in sandbox (`@anthropic-ai/sandbox-runtime`) OS-enforces filesystem and network restrictions around shell commands via macOS Seatbelt and a network proxy. Explicitly start with `allowedDomains: []`; do not rely on defaults. Shell/verification network, including loopback, remains unavailable. Trusted model transport is outside the shell boundary; do not widen shell networking to make authentication work.

**Read/Edit/Write file tools run outside the Bash sandbox.** They are governed by application-level tool permissions, not Seatbelt. `canUseTool` is also application-level gating. Neither equals OS sandboxing. A shell preflight cannot prove native file-tool isolation. This difference requires an explicit owner security decision.

Compensating policy, subject to reference/version validation:

- Require shell sandboxing; fail closed when unavailable. Disable unsandboxed fallback and reject tool requests to bypass it. Confirm enforceable equivalents of `enabled` and `allowUnsandboxedCommands: false` rather than assuming option names or defaults.
- Explicit shell filesystem denies cover controller, storage, repository, original login, attempt auth/config, worker/GitHub/project credential files, `.ssh`, keychain locations and nested `.env`/`.env.*`. Writable scope is the approved workspace and scratch; preserve read-only project paths and Git metadata.
- Separately deny credential/config paths in native tool permissions. Validate Read/Edit/Write and every allowed search/glob/notebook or indirect-read surface against canonical containment, traversal, symlinks, aliases, protected files and read-only rules. Verify exact documented rule syntax and precedence.
- Make `canUseTool` deny by default. Permit only enumerated tools with validated inputs. Deny unknown tools, web/network tools, MCP, subagents, dynamic discovery and permission bypass. Never use bypass-permissions mode. Determine which auto-allowed tools bypass the callback; independent deny rules are mandatory.
- Keep `allowedDomains: []`, no arbitrary sockets or automatic exclusions, and no prompt-driven widening. Verify denied requests terminate without approval interaction.
- Explicitly scrub tool-subprocess environments. Keep transport credentials out of shell environment, inherited descriptors and process-inspection paths; isolated HOME alone is insufficient. Demonstrate this with the official binary or block release.

If application-level file restrictions do not meet the required threat model, stop. Owner options are to accept the documented boundary, investigate a supported shell-only tool surface with native file tools disabled, or authorize stronger process/container isolation. The latter is a separate architecture/server change, not implied authorization.

Initially retain the existing OS-enforced offline verification runner, even though it depends on the pinned Codex CLI. Document that deployment dependency. Replacing it is a separate reviewed change: Claude's model Bash sandbox does not automatically wrap controller-launched checks.

## 3. Credential hygiene parity

The current parent builds child environments from an allowlist, not the worker environment. `codex-session.mjs` passes that restricted environment to the SDK, removes `CODEX_HOME/auth.json` on disconnect and in `finally`, and the parent deletes attempt auth. Runner recovery calls `cleanupAttemptAuth`, which currently accepts only a direct temporary child named `conduit-codex-*`. A Claude prefix needs its own validated recovery handling; merely renaming paths breaks parity.

Requirements before credential use:

1. Private attempt directories (0700), credential files (0600), and no tokens in journals. Allowlist environment variables. Exclude worker/API/DB/GitHub secrets, credential helpers, inherited Anthropic keys/OAuth-token variables, proxy/base-URL overrides, alternate cloud-provider settings, `NODE_OPTIONS` and library injection. Add only documented, owner-approved login material to trusted transport. No ambient paid-API fallback.
2. Use the documented isolated Claude config-home mechanism. Never blindly copy a user's Claude directory: it can contain hooks, MCP, plugins, trust, sessions and instructions. Establish whether the approved version uses files or macOS Keychain. Do not read/export Keychain or invent token extraction. Shared credential-store access requires a reviewed owner decision.
3. Inventory actual credential and refresh artifacts. Candidate names include `.credentials.json`, `.claude.json`, config-home files, backup/temp files, transcripts, debug logs and caches; these are candidates to verify, not an authoritative inventory. Keep them outside publishable workspaces.
4. Clean all attempt-owned credential/config artifacts on success, failure, cancellation and disconnect, including artifacts under private HOME/scratch. Parent cleanup follows process-group teardown. Crash recovery validates provider-specific recorded paths and cleans before retry. Never recursively delete caller-selected/symlink-redirected paths or the owner's original login. Preserve worktrees and sanitized recovery evidence.
5. Extend log redaction in `codex.ts` and secret detection/withholding in `development/git.ts` and change inspection with explicit Anthropic API/OAuth patterns, including `sk-ant-api...`, `sk-ant-oat...` and documented refresh/bearer forms. Existing generic `sk-` handling is not proof of coverage. Test chunk boundaries and nested SDK errors; redact before truncating. Avoid raw event logging. Pattern matching is a backstop, not isolation.

## 4. Subscription route and exact configuration question

Preserve all supplied legal/compliance distinctions:

- OAuth is intended for subscribers' ordinary use of Claude Code and native Anthropic applications.
- Agent SDK/product integrations are directed toward API-key authentication.
- Third-party routing of subscription credentials is prohibited.
- An end user signing into the unmodified official Claude Code binary with their own subscription is explicitly permitted, including hosted use.

Permission to run that binary hosted does **not alone establish** that Conduit's SDK-driven product workflow supports subscription authentication. Bundling the unmodified binary is necessary to this proposal, not sufficient evidence that every integration use is permitted. Do not pool accounts, distribute credentials or implement an OAuth service for users.

Headless bare mode ignores OAuth. **Do not use `--bare`.** The candidate is non-bare headless/SDK execution with the owner's ordinary official login, contingent on primary-source confirmation for this integration. An API key is not a silent fallback. Signup, purchase and paid testing remain outside scope.

Non-bare discovery must be neutralized explicitly: proposed `settingSources: []` plus controlled explicit settings; no inherited user/project/local settings, hooks (including SDK hooks), MCP servers, plugins, external agents/skills or CLAUDE.md instructions. Empty settings sources must not be assumed to disable CLAUDE.md or every extension surface. Verify a documented control for each, including parent-directory and auto-memory discovery. If supported controls cannot disable discovery, record a blocker rather than patching the binary or relying on prompt instructions.

**Exact officially supported subscription + scripted SDK configuration is unresolved in this restricted offline task.** Before implementation:

1. Review current primary text through an authorized channel; record date/version and relevant excerpts, not just links.
2. Resolve whether this owner's hosted SDK workflow qualifies as supported ordinary use or API-only integration. If official text leaves ambiguity, ask Brett to obtain Anthropic clarification. Owner approval cannot override provider terms.
3. Establish documented non-bare login/config options without OAuth injection, API-key fallback, Keychain export or binary modification; verify isolation and refresh behavior.
4. Validate precise discovery/permission controls against the approved SDK reference/types and synthetic execution; only then publish an executable options recipe.

If subscription SDK support cannot be established, return the documented constraints to Brett. A direct official CLI alternative requires a revised architecture approval. Do not claim this memo has resolved the exact configuration by guessing an options object.

## 5. Routing and production migration

`orchestrator.jobs.task` is CHECK-constrained. `20261105062426_persistent_projects.sql` allows `simulate-development`, `simulate-failure`, `codex_task`, `development`; it also requires project/root/instructions/base-branch fields specifically for `development`. `runner.ts` has a matching union, dispatch and recovery whitelist. A TypeScript-only new Claude task cannot work against production.

| Option | Scope and tradeoff |
| --- | --- |
| New `claude_task`/Claude-development type plus migration | Update `jobs_task_check`, development-specific invariants and task-filtered claim/retry/revision/dependency/authorization paths, API validation, runner/recovery, events and UI. Separate fixture tasks from development safeguards. Requires explicitly approved production migration and coordinated rollout; duplicates provider concerns across lifecycle paths. |
| Agent selector on existing `development` | Persist a validated provider, default legacy jobs to Codex, and carry it through claims, revisions, retries and recovery. Requires schema/API/journal/config/UI/capability changes as appropriate; not necessarily migration-free. Retains existing development constraints and publication lifecycle. |

Recommendation for Brett: **agent selector on `development`** for real projects; retain `codex_task` as the current disposable fixture path. Development describes lifecycle, provider describes execution policy. Keep provider immutable for an in-flight/root execution absent an explicit future policy. Unknown providers fail closed; never run Claude-selected work with Codex or fall through to simulation. Add capability-aware claiming before enqueueing Claude work so old workers cannot claim it. Review SQL functions and all task-specific paths, not just the constraint.

Neither option is implemented or approved. A new Claude fixture task would also require a migration if represented by a new task value. Deployment and rollback coordination require explicit owner server approval.

## 6. Verification, timeout, journal parity and offline tests

Current `timeoutMs` reads `CODEX_TIMEOUT_MS`, default 180000, range 1000–1800000. Development renews every three seconds, aborts on stopping/lease loss, uses SDK cancellation plus parent process-group kill, and requires a completed turn and successful child exit. Verification has per-check deadlines and sandboxing. `run.ts` records execution/publication stages, preserves failed changes and reconciles verified/committed/pushed/published checkpoints without blindly rerunning the model. Runner persists outcomes before reporting and rejects malformed journals.

Claude must preserve SDK cancellation plus an independent parent deadline, awaited exit, bounded teardown and no orphan tool descendants. Ownership/transport failures return to lease recovery rather than becoming fabricated success. Renew during verification; interrupted, timed-out or nonzero checks fail. Models cannot declare checks passed, alter configured verification or publish. Preserve explicit retry semantics. A provider-neutral timeout setting with backward compatibility is a later reviewed change.

Version journal extensions with provider, SDK/binary/policy versions, validated attempt path and sanitized terminal evidence. Recovery preserves selection, cleans credentials, respects fencing and resumes durable verified/publication checkpoints without another model turn. Saved outcomes remain idempotently reportable. Session IDs are diagnostic until separately designed/tested resume semantics exist; never automatically replay an interrupted turn.

Future offline validation plan, with no model calls or network:

| Layer | Required evidence |
| --- | --- |
| Stream contracts | Mock the SDK boundary with versioned synthetic fixtures first; add sanitized authorized recordings later with provenance. Cover session/init, tools, success/errors, max-turn/budget stops, unknown/malformed/oversized messages, missing/duplicate terminal results, truncated streams and nonzero exit after success. Assert bounded redacted IPC and fail-closed completion. |
| Process/lifecycle | Fake launch failure, disconnect, SDK exception, deadline, stop, lease loss, cancellation-resistant descendants, cleanup failure and crash recovery. Assert teardown, cleanup-before-retry, preserved worktrees, no publication after failure, legacy journal compatibility and no model rerun after verified checkpoints. |
| Sandbox configuration | Behavioral checks for filesystem denies, empty domains, bypass disabled, protected paths, escaping/aliases, read-only policy and missing sandbox support. Generated snapshots alone do not demonstrate enforcement. |
| OS enforcement | Separate macOS offline sentinel tests: shell cannot read credentials/controller files, write Git metadata/protected/read-only files, or reach network/loopback; approved workspace/scratch writes work. Require actual Seatbelt evidence. Nested sandbox execution may require the separate verification environment; mocks cannot replace this. |
| Native file tools | Independently exercise Read/Edit/Write/search and each permitted tool against traversal, symlink aliases, protected sentinels and unknown tools. Establish deny-rule/callback precedence with the pinned official binary without model calls where supported. Paths that cannot be exercised offline remain explicitly unverified, never an OS sandbox pass. |
| Credentials/discovery | Synthetic canaries only: no inherited worker/API/DB/GitHub secrets, alternate auth, hooks/MCP/plugins/CLAUDE.md loads, or credentials in tool subprocesses, IPC, transcripts, diffs, check output, journals and reports. Exercise disconnect, forced kill/restart, refresh-like artifacts and invalid cleanup paths. No real credential reads required. |
| Routing/recovery | Legacy jobs remain Codex; selected Claude remains Claude across retries/revisions/recovery; unsupported workers cannot claim it; unknown providers fail closed. Check SQL/field invariants, mixed-version rollout, outcome retries and publication reconciliation using mocks/disposable DB in the authorized verification environment. |

Relevant existing tests include `tests/codex.test.ts`, `tests/real-codex.test.ts` and `tests/worker-config.test.ts`. Future tests should verify contracts rather than relabel Codex expectations. Verification runs separately in an offline sandbox where loopback sockets are unavailable. No runtime suite is necessary for this document-only change.

**Offline tests do not certify live model compatibility, subscription eligibility, OAuth refresh, live SDK login or production isolation.** A mock pass establishes adapter behavior only; real OS and native-tool enforcement evidence must be identified separately.

## 7. Staged work and deferred live calibration

These are proposed initiative task slices, not newly enqueued jobs or implementation authorization:

1. **Primary-source/owner gate:** resolve subscription support and exact configuration; obtain Brett's explicit architecture, security and routing decisions. No credentials needed.
2. **Offline contract spike:** after architecture approval, pin official SDK/binary and build the parallel adapter with synthetic streams, fail-closed policy and cancellation tests. No model calls.
3. **Credential/security implementation:** only after credential approval, implement isolated documented login/config handling, subprocess scrubbing, cleanup/recovery and redaction. Prove shell and native-file restrictions separately; stop if approved requirements cannot be met.
4. **Routing/lifecycle integration:** implement the chosen selector, capability-aware claims, immutable provider recovery and verification/publication parity. Prepare migration/rollout/rollback for review; no production migration or server change without explicit approval.
5. **Offline review gate:** assess contract, lifecycle, security and sandbox evidence, record unsupported paths and keep Claude disabled for real work.
6. **Deferred live calibration:** only once Brett supplies an eligible subscription and explicit live-test scope/authorization. Use official login and a disposable approved project; verify non-bare scripted operation, login/refresh, discovery suppression, edits, denials, cancellation, timeouts and cleanup. Keep shell/check network closed while trusted transport connects. No paid API fallback. Review sanitized outcomes before enabling real jobs.

Live calibration needs agreed stop conditions, approved versions and eligibility evidence. Stop on authentication ambiguity, an unexpected billing route, credential exposure, unsandboxed commands or policy bypass. Clean attempt credentials and preserve sanitized recovery evidence; failures do not authorize weakening policy.

### Explicit open decisions

- **D1 — Brett + primary-source review:** Is this hosted SDK subscription use officially supported, and what exact non-bare configuration is documented? Unresolved; blocks auth implementation.
- **D2 — Brett, architecture:** Approve parallel adapter first and later abstraction, reusing the development lifecycle? Proposed, not approved.
- **D3 — Brett, security:** Accept application-level native file-tool controls or require a verified reduced tool surface/stronger OS boundary? Compensations do not establish OS parity.
- **D4 — Brett, credentials:** Which documented isolated login store supports cleanup/refresh without unrelated configuration copying or Keychain export? Unresolved.
- **D5 — Brett, routing/server:** Approve development selector, capability-aware claims and associated migration/rollout? Recommended, not approved.
- **D6 — Implementation review:** Can the pinned version disable discovery, isolate tool environments and fail closed on sandbox gaps? Must be demonstrated.
- **D7 — Brett:** Subscription availability and live-test authorization/scope? Deferred; none supplied.

### PM review record and publication handoff

PM review status: **pending; no PM approval received or inferred.** This records review state, not a completed review. No authorized reviewer identity/channel was supplied, and this task does not authorize messaging others. Conduit/PM should record reviewer, date, disposition, decision IDs and follow-up task identifiers here or in the draft PR. Actual review remains an acceptance requirement; the author must not label this memo PM-approved.

PM checklist: verify all seven sections and offline limits, resolve D1–D7, confirm no credential/architecture/server authorization is implied, keep live calibration deferred, and turn approved slices into staged tasks. Acceptance also requires Conduit to commit this document and publish a draft PR. This session prepares the document only and must not modify Git metadata, commit, push or publish.
