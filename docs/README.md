# Conduit documentation

[Project overview](../README.md)

[Read-only web console](gui.md)

[Phase 5B persistent initiatives](phase-5b-initiatives.md) · [Phase 5A agent protocol and rollout](phase-5a-agent-protocol.md) · [Instinct standing instruction](instinct-standing-instruction.md)

## Setup and operation

| Guide                                                   | Use it for                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [API and worker operator guide](operator-guide.md)      | Local setup, keys, API contract, lease guarantees and journal recovery                                                        |
| [Hosted deployment](deployment.md)                      | Vercel/Supabase setup, TLS, runtime roles, cutover and rollback; includes dated deployment records                            |
| [Registered projects and draft PRs](PHASE_4_TESTING.md) | GitHub policy, registration, worktrees, development/revision payloads, diff review, publication recovery and operator cleanup |
| [Fixed Codex sandbox](PHASE_3_TESTING.md)               | Codex prerequisites, TypeScript fixture, execution limits and opt-in smoke checks                                             |
| [Instinct integration](instinct.md)                     | Submitter contract, idempotency, polling and external acceptance                                                              |
| [Manual recovery checks](manual-test.md)                | Connectivity, network interruption and worker restart scenarios                                                               |

## Verification and history

**Separate configured worker checks from complete verification.** The documented Conduit worker profile runs route-type generation, TypeScript checking and offline unit tests. Its administrator-owned configuration is private and can vary by installation. The network-disabled sandbox cannot run the full PostgreSQL/HTTP suite unchanged. Run `npm test`, `npm run build` and `npm run typecheck` in a prepared trusted environment before merging; real Codex and live GitHub probes have additional opt-in prerequisites.

These records retain the context and limitations of earlier runs. They are not a current health report or proof that every later revision passed the same checks.

- [Migration and hosted verification evidence](verification.md): dated checks, pending external acceptance and observability limits.
- [Phase 3 testing](PHASE_3_TESTING.md): fixed-sandbox implementation and verification evidence.
- [Phase 4 implementation handoff](PHASE_4_IMPLEMENTATION.md): architecture, historical rollout, real draft-PR/revision proof and known limits.
- [Phase 4 testing](PHASE_4_TESTING.md): detailed contracts and recovery matrix, alongside historical verification notes.

The following prompts are retained as integration history. They reference the installation and task that existed when written; they are not general setup instructions or a source of current administrator permissions:

- [Original connectivity prompt](instinct-test-prompt.md)
- [Phase 4 acceptance prompt](instinct-phase4-test-prompt.md)
- [Development / info-endpoint prompt](instinct-development-prompt.md)

For current capabilities, inspect the checked-out implementation. `/info` describes the code statically; `/health`, authenticated `/auth-check`, `/api/workers` and an end-to-end job probe address different aspects of live readiness. Historical deployment records do not establish which commit an installation currently serves.
