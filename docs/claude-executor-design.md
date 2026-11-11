# Claude executor compatibility design

Status: proposal, docs only, revised 2026-11-11 (narrow configuration-discovery and subscription-transport evidence correction; prior evidence reconciled 2026-11-08). No behavior or dependency changes. Brett wants staged Claude support using his own subscription; he currently has no subscription available for testing. No API usage, purchase, signup or live model call is authorized. Credential, architecture and server changes require his explicit approval first.

## How to read the evidence labels

Every load-bearing claim in this memo is labeled:

- **[PROVIDER]**: a statement from Anthropic's official documentation, quoted or closely paraphrased, with URL and fetch date 2026-11-08. The PM fetched these; the author of this memo had no network access and did not independently retrieve them.
- **[INTERPRETATION]**: our reading of provider text or repo code. Not a provider statement. Where an interpretation is uncertain, the uncertainty is stated, not smoothed over.
- **UNVERIFIED**: no evidence yet; requires demonstration on the host or a live subscription. Listed in the proof-gates register.

Primary sources (all fetched 2026-11-08):

| Source | URL |
| --- | --- |
| Legal and compliance | https://code.claude.com/docs/en/legal-and-compliance |
| Authentication | https://code.claude.com/docs/en/authentication |
| Headless mode | https://code.claude.com/docs/en/headless |
| Sandboxing | https://code.claude.com/docs/en/sandboxing |
| Permissions | https://code.claude.com/docs/en/permissions |
| Agent SDK TypeScript reference | https://code.claude.com/docs/en/agent-sdk/typescript |
| Environment variables | https://code.claude.com/docs/en/env-vars |

Repository evidence: `worker/codex.ts`, `worker/codex-session.mjs`, `worker/development/executor.ts`, `worker/development/run.ts`, `worker/runner.ts`, `worker/development/git.ts`, `worker/development/changes.ts`, `supabase/migrations/20261105062426_persistent_projects.sql`. `package.json` pins `@openai/codex-sdk` 0.166.0 and contains no Claude SDK dependency.

## 1. Executor parity and insertion point

Recommendation for owner approval [INTERPRETATION]: add a parallel Claude session adapter first, retaining the existing development lifecycle, then extract a shared agent-executor interface after both providers have contract coverage. Avoid duplicating `development/run.ts` or its publication state machine. A narrow provider-selection seam in `executeWorktree` is sufficient initially.

`worker/claude-session.mjs` would sit beside `worker/codex-session.mjs`, driving the official `@anthropic-ai/claude-agent-sdk`, which bundles the unmodified official Claude Code binary. Verify and pin package/binary provenance before adding a dependency. Never patch the binary, intercept OAuth, replace its transport or route subscription credentials through an alternate endpoint.

[PROVIDER, headless] "Use the Agent SDK to run Claude Code programmatically from the CLI, Python, or TypeScript." `claude -p` is the Agent SDK's CLI form: the SDK and the stock CLI are the same unmodified binary and the same authentication chain. [INTERPRETATION] SDK-vs-CLI is therefore not a compliance distinction. The SDK is recommended on engineering grounds only: typed lifecycle, cancellation, terminal results, and structured stream contracts.

| Existing boundary | Claude parity requirement |
| --- | --- |
| `executeCodex(job, renew, stopping, rememberAttempt)` | Disposable TypeScript fixture path, distinct from real development. A Claude fixture adapter must preserve bounded snapshots and verification. |
| `executeWorktree(...)` | Retain worktree policy, dependency preparation, development/retry context and callbacks. Select provider-specific security setup and child after validated routing. |
| Private attempt directory and `remember` | Journal a validated provider-tagged attempt before credential reference or SDK startup. |
| Detached trusted Node child, IPC `{workspace, timeout, instructions}` | Same input semantics, approved executable and working directory; parent owns termination. Never accept an arbitrary caller-selected binary/config path. |
| Codex thread, completion and error events | Normalize Claude session ID and SDK terminal result into session/success/failure events. Require a successful terminal result AND successful child exit; assistant text or exit zero alone is insufficient. Validate actual discriminants against the pinned SDK. |
| Bounded IPC summaries | Allowlist event fields, redact before truncation, omit raw SDK messages/content blocks/tool inputs. |
| `Execution = { thread_id?, checks }` | Preserve callers; versioned provider/session metadata in journals/results. A Claude session is not a resumable Codex thread. |
| `run.ts` locks, changes and publication checkpoints | Reuse existing lifecycle safeguards. The controller verifies/publishes; the model receives no GitHub publishing credentials. |

## 2. Sandbox translation and limits

Current development explicitly requires macOS and Node 24. `developmentSandboxConfig` grants workspace/scratch writes, read-only Git metadata, denies controller/storage/repository/login and credential paths, and disables network. Verification uses `sandboxCommand` (`codex sandbox -P conduit -C <workspace> -- ...`); its tested macOS boundary is `sandbox-exec`/Seatbelt.

### 2.1 What the Claude sandbox covers - and what it does not

- [PROVIDER, sandboxing] "The sandbox covers shell commands only. Claude's file tools, MCP servers, and hooks run outside it." The built-in Bash sandbox uses macOS Seatbelt plus a network proxy whose allowed domains start empty.
- [PROVIDER, sandboxing] "allowedDomains doesn't limit WebFetch" - process-level web tools bypass the shell network policy entirely.
- [PROVIDER, permissions] "Claude makes a best-effort attempt to apply Read(path) deny rules to all built-in tools that read files like Grep and Glob." App-level file deny rules are documented best-effort for indirect readers. `canUseTool` is also application-level gating. **Neither equals OS sandboxing, and the documentation says so.** This is the core D3 gap, confirmed by the provider's own text.
- [PROVIDER, sandboxing] Fail-closed exists: "To make Claude Code exit at startup instead, set `sandbox.failIfUnavailable` to `true`." Unsandboxed fallback is controlled by `allowUnsandboxedCommands` (set false).
- [PROVIDER, sandboxing] Credential protection for shell children: "The `sandbox.credentials` setting declares credential files and environment variables to protect from sandboxed commands... For entries with mode deny, file paths are denied for reads inside the sandbox... and environment variables are unset before each sandboxed command runs." Sandboxed commands otherwise inherit Claude Code's environment, including secrets; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is the documented scrub control and also forces filesystem isolation on.

### 2.2 Transport separation - corrected architecture [INTERPRETATION, PROVISIONAL]

An earlier sketch proposed wrapping the whole Claude process in the existing network-disabled Seatbelt profile. **Rejected**: the Claude Code process itself makes the model API calls; a network-dead outer profile breaks transport. The correct separation is architectural:

1. The **process** holds the subscription login and makes API calls. Tool children (shell commands) never hold transport credentials: the inner sandbox gives children `network.allowedDomains: []` plus env scrubbing, so even a malicious or confused shell command has no network and no tokens.
2. The **outer whole-process boundary** is the documented direction for covering file tools: [PROVIDER, sandboxing] "To put the tools, processes, and commands in this section behind one boundary, run the Claude Code process itself in a container, virtual machine, or the sandbox runtime." The sandbox is built on the open-source `@anthropic-ai/sandbox-runtime` package. The proposed outer policy must distinguish model transport from subscription authentication and refresh. [PROVIDER, sandbox environments, fetched 2026-11-11] https://code.claude.com/docs/en/sandbox-environments lists `api.anthropic.com` for model access and additionally `claude.ai` and `platform.claude.com` for OAuth sign-in and refresh. These are documented requirements, not a verified sufficient allowlist for this worker. [INTERPRETATION, PROVISIONAL] An API-endpoint-only allowlist is therefore incomplete for the proposed subscription lifecycle. Any eventual domain policy remains subject to owner approval and pinned-version host proof, with filesystem denies covering controller/storage/credential paths for the whole process tree - giving OS enforcement over Read/Edit/Write, which app-level rules cannot guarantee (2.1).
3. **Process-level web tools** (WebFetch/WebSearch) run in-process and outside any shell sandbox: exclude them from the enumerated allowed tool set entirely (deterministic absence, not a deny rule).

**Proof gates - all UNVERIFIED, none assumed:**

- G1: Nested outer/inner sandbox proxies and loopback behavior (the inner proxy inside the outer sandbox) - undocumented; must be demonstrated on the worker host.
- G2: Whether tool children can inherit or reach the parent process's transport credentials/network channel through the outer boundary (e.g. via inherited descriptors, the config dir the process itself must read, or loopback to the outer proxy). The outer policy must allow the binary's own auth while excluding untrusted file-tool access to credential paths. Until demonstrated, this implementation shape is NOT called supported.
- G3: Shared config-dir concurrency (see 3.2).
- G4: Keychain vs file credential behavior under a custom `CLAUDE_CONFIG_DIR` on the worker (see 3.2).

### 2.3 Verification runner

Initially retain the existing OS-enforced offline verification runner (depends on the pinned Codex CLI; document that deployment dependency). Replacing it is a separate reviewed change: Claude's model Bash sandbox does not automatically wrap controller-launched checks.

## 3. Credential hygiene - corrected model

### 3.1 Rejected: per-attempt credential lifecycle

The previous draft proposed per-attempt credential creation and cleanup. **Rejected on provider evidence:**

- [PROVIDER, authentication] "run `/logout`, which removes and revokes the credential this sign-in wrote." Per-attempt logout would revoke the owner's subscription login on every run.
- [PROVIDER, legal] "developers may not collect, store, or intermediate Claude.ai credentials or session tokens - sign-in to a Claude account must complete through Anthropic's own flow." Copying credential files between directories edges toward this prohibition; do not copy, export, or extract tokens. No Keychain export, ever.

### 3.2 Accepted direction: one persistent isolated config dir [INTERPRETATION, PROVISIONAL]

- [PROVIDER, authentication] Storage: "On macOS, credentials are stored in the encrypted macOS Keychain... [on Keychain write failure] `~/.claude/.credentials.json` with file mode 0600... If you've set the `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the `.credentials.json` file under that directory instead, including the file the macOS fallback writes, and keys the macOS Keychain entry to that directory too."
- [PROVIDER, authentication] Unattended reuse: an earlier `claude auth login` sign-in skips the login prompt on later launches.
- [PROVIDER, authentication] Refresh: "Once the stored login expires and can't be refreshed, each model request fails with 'Login expired - Please run /login' until you sign in again" - stored logins refresh automatically until unrecoverable.
- [PROVIDER, headless] "In bare mode, Claude Code never reads OAuth credentials or the system keychain" - so non-bare headless/SDK reads the stored subscription login. Do not use `--bare`.

Model: ONE persistent Conduit-owned `CLAUDE_CONFIG_DIR` (0700) that Brett signs into once interactively through Anthropic's own flow. The binary refreshes. Attempts reference it via environment; attempt dirs never contain credentials. Decommission = documented `claude auth logout` under that config dir + delete. No copying, no export, no per-attempt logout.

UNVERIFIED: (G3) concurrent attempts sharing one config dir - refresh write races are undocumented; (G4) whether the worker's Keychain write path or file fallback applies under a custom `CLAUDE_CONFIG_DIR`, and the cleanup implications of each. Both require host demonstration; until then the credential model is provisional.

### 3.3 Standing hygiene requirements (unchanged)

Allowlist child environments; exclude worker/API/DB/GitHub secrets, credential helpers, inherited Anthropic key/token variables, proxy/base-URL overrides, `NODE_OPTIONS` and library injection. Extend log redaction and secret detection with Anthropic patterns (`sk-ant-api...`, `sk-ant-oat...`, documented refresh/bearer forms) as a backstop, not isolation. Redact before truncating. Test chunk boundaries and nested SDK errors.

## 4. Subscription route and the compliance question

[PROVIDER, legal] the controlling text:

- "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
- "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under Can customers offer Claude Code in their products? above."
- "For questions about permitted authentication methods for your use case, please contact sales."

[INTERPRETATION] Conduit's case is a single individual (Brett) running his own orchestrator on his own hardware, launching the unmodified binary through Anthropic's own login flow, billed to his own plan, with no third-party users and no credential intermediation. Under that reading the enumerated prohibitions do not apply, and the usage-limits sentence contemplates individual Agent SDK usage on subscription plans.

**Unresolved [INTERPRETATION, flagged as compliance question, not owner preference]:** "ordinary, individual usage" is undefined for personal orchestration volume, and the hosting paragraph's Commercial-Terms trigger is written for customer/end-user products rather than personal automation. This memo does not declare the route eligible. The resolution path is provider clarification: Appendix A contains a prepared internal draft (not sent) asking Anthropic whether this exact workflow is permitted. Owner approval cannot waive provider terms; if Anthropic's answer or the text leaves the route ineligible, the compliant fallback is API-key authentication, which Brett has declined for now - in that case Claude support stays blocked, and that outcome is recorded honestly rather than worked around.

## 5. Routing and production migration (unchanged analysis)

`orchestrator.jobs.task` is CHECK-constrained (`jobs_task_check`: simulate-development, simulate-failure, codex_task, development). A TypeScript-only new Claude task cannot work against production. Options remain: (a) new task type plus approved production migration; (b) agent selector on `development` (recommended [INTERPRETATION]: development describes lifecycle, provider describes execution policy; provider immutable in-flight; unknown providers fail closed; capability-aware claiming so old workers cannot claim Claude work). Neither is implemented or approved. Deployment and rollback coordination require explicit owner server approval.

## 6. Verification: three tiers, honestly separated

**Tier 1 - offline contract tests (mocks).** Prove adapter, stream, lifecycle, routing and journal behavior ONLY: versioned synthetic SDK fixtures (session/init, tools, success/errors, max-turn/budget stops, malformed/oversized/duplicate-terminal messages, truncated streams, nonzero exit after success), lifecycle fakes (launch failure, disconnect, deadline, lease loss, cancellation-resistant descendants, cleanup failure, crash recovery), routing recovery (legacy stays Codex, Claude stays Claude, unsupported workers cannot claim). A mock pass establishes adapter behavior only.

**Tier 2 - real host sentinel tests on the worker.** Separate, required, and NOT replaceable by mocks: Seatbelt denial checks (shell cannot read credentials/controller, cannot write protected paths, no network/loopback), the G1/G2 outer-boundary demonstrations, env scrubbing, Keychain/config-dir keying (G4), shared-config concurrency (G3), and file-tool deny behavior against traversal/symlink/protected sentinels with the pinned official binary. Paths that cannot be exercised remain explicitly unverified.

**Tier 3 - live.** Auth, refresh, transport, subscription eligibility and live SDK login remain UNVERIFIED until Brett has a subscription and authorizes a scoped live test. Offline tiers never certify live model compatibility, OAuth refresh, or production isolation.

## 7. Staged work and decision register

Proposed slices, not enqueued jobs or authorization:

1. **Provider clarification + owner gates:** send Appendix A (or equivalent) through a channel Brett approves; obtain his architecture, security and routing decisions. No credentials needed.
2. **Offline contract spike (Tier 1):** after architecture approval, pin official SDK/binary and build the parallel adapter with synthetic streams and fail-closed policy tests. No model calls.
3. **Host sentinel program (Tier 2):** demonstrate G1-G4 on the worker with the pinned binary. Stop if approved requirements cannot be met.
4. **Credential/security implementation:** only after credential approval and Tier 2 evidence.
5. **Routing/lifecycle integration:** chosen selector, capability-aware claims, immutable provider recovery, verification/publication parity. Migration/rollout prepared for review; no production migration without explicit approval.
6. **Offline review gate:** assess contract, lifecycle, security and sandbox evidence; keep Claude disabled for real work.
7. **Deferred live calibration (Tier 3):** only with an eligible subscription and explicit live-test authorization. Official login, disposable approved project; shell/check network closed while trusted transport connects; no paid API fallback; stop on authentication ambiguity, unexpected billing route, credential exposure, unsandboxed commands or policy bypass.

### Decision register (revised)

- **D1 - provider, compliance:** Is this personal local subscription workflow permitted? Resolution path: Appendix A clarification to Anthropic ("contact sales" is the docs' own escalation). UNRESOLVED; blocks auth implementation. Not waivable by owner preference.
- **D2 - Brett, architecture:** Approve parallel adapter first, later abstraction, reusing the development lifecycle? Proposed, not approved.
- **D3 - Brett, security:** File tools outside the OS sandbox are now documented best-effort at app level [PROVIDER]. The compensating outer whole-process boundary is PROVISIONAL pending G1/G2. Decision: accept the documented app-level boundary, require the outer boundary, or require stronger isolation - after host evidence exists.
- **D4 - RESOLVED as design direction [PROVIDER-backed, PROVISIONAL]:** single persistent isolated `CLAUDE_CONFIG_DIR`; no per-attempt create/logout; no copying. Remaining unknowns are G3/G4 host behavior, not design choices.
- **D5 - Brett, routing/server:** Approve development selector, capability-aware claims and associated migration/rollout? Recommended, not approved.
- **D6 - PARTIALLY SPECIFIED, NOT PROVEN ISOLATED:** [PROVIDER, fetched 2026-11-11] https://code.claude.com/docs/en/agent-sdk/claude-code-features says `settingSources: []` excludes user/project/local filesystem settings, but is not a universal ambient-input boundary. Its documented exceptions include endpoint-managed policy and eligible server-managed settings; global `~/.claude.json` config (relocated with `CLAUDE_CONFIG_DIR`); auto memory unless separately disabled; account MCP connectors unless separately restricted; and restrictive credential-protection entries that can still apply. Empty `mcpServers: {}` alone does not suppress account connectors; `strictMcpConfig: true` is a separate documented control. The TypeScript reference also documents this control: https://code.claude.com/docs/en/agent-sdk/typescript .
  - [INTERPRETATION] Keep explicit filesystem settings sources, a controlled config directory and worktree parent chain, separate auto-memory controls, and strict MCP configuration in the proposed test matrix. Do not remove mandatory policy or restrictive credential protection to make a test pass. Inventory effective host policy without reading credential values. Managed/global inputs must not be described as neutralized merely because `settingSources` is empty.
  - UNVERIFIED: exact effective inputs, precedence and tool surface on the pinned SDK/binary and worker host. Tier 2 must demonstrate them; no SDK/host experiment was performed for this documentation correction.
- **D7 - Brett:** Subscription availability and live-test authorization/scope. Deferred; none supplied.

### Proof-gate register (consolidated UNVERIFIED list)

- G1 nested outer/inner sandbox proxies and loopback behavior.
- G2 tool-child access to parent transport credentials/network through the outer boundary; outer policy allows binary auth while excluding untrusted file-tool access.
- G3 shared config-dir concurrency under parallel attempts.
- G4 Keychain vs file credential behavior under custom `CLAUDE_CONFIG_DIR` on the worker.
- G5 ambient configuration and discovery: effective managed/global inputs, memory and connector controls on the pinned SDK/worker, without removing mandatory policies.
- Live auth/refresh/transport/eligibility (Tier 3), including separately documented OAuth refresh domains - blocked on subscription + authorization.

## Appendix A - provider clarification draft (internal proposal, NOT sent)

To be sent only through a channel Brett explicitly approves, to Anthropic (the docs direct permitted-auth questions to sales):

> Hello, I run a personal project on my own machine: a local orchestrator that launches the unmodified official Claude Code binary (via the Agent SDK / `claude -p`) to work on my own repositories. I am the only user. I would sign in through your standard flow with my own Claude subscription, all usage billed to my own plan; no credentials are collected, stored for others, resold, or intermediated, and no third-party users are involved. Is this permitted as ordinary individual usage of Claude Code / the Agent SDK under my subscription, and are there any additional terms that apply to this configuration? Thank you.

## PM review record and publication handoff

- PM review `f2ef7c98-d3eb-4f81-8826-d084a44f8db3` (2026-11-08) assessed the ORIGINAL 2026-11-07 memo as a problem map: ready_for_human_review on that basis, while noting its configuration answers needed evidence reconciliation.
- This revised memo is that reconciliation. PM review of the REVISED memo is pending and remains an acceptance requirement; the author must not label this memo PM-approved.
- PM checklist for the revised review: all seven sections; evidence labels and dates present; per-attempt credential model removed; network-dead outer wrap removed; proof gates G1-G4 explicit; three verification tiers separated; Appendix A present and marked not sent; no code/config/dependency changes; no live-compatibility claims.


## 2026-11-11 narrow review update

Two documentation issues were corrected from newly fetched official pages: D6 no longer claims ambient discovery isolation is resolved, and the proposed subscription transport policy now distinguishes model access from OAuth sign-in/refresh domains. This is a proposal correction only: no network/configuration, credential, runtime, dependency, migration, merge or deployment change. The original staged initiative remains paused and the separate scanner-quarantined contract work remains untouched. No fresh host or live compatibility evidence is claimed. A fresh PM assessment records the exact reviewed commit separately.
