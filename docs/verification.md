# Conduit migration verification

## Scope

The earlier Instinct → Cloudflare → local API/PostgreSQL → Mac worker → Instinct loop was observed working. This change prepares the same HTTP/queue contract for Vercel and Supabase and replaces hourly credentials with scoped, revocable 30-day keys.

Cloud creation and deployment were approved on November 4, 2026. The project directory was renamed to `/Users/brettberry/Coding/Apps/conduit-poc`. Dedicated Supabase project `noftwqvntanjjgdchmmy` and Vercel project `prj_hJEeIrQwueIgVsyQcBkQDmg0ulDL` are deployed. Existing local POC data was preserved; it was not imported or replayed. The old local API, worker, database process and Cloudflare tunnel were stopped gracefully for the directory rename. The hosted worker is running separately.

The new Instinct-specific external acceptance gate remains pending: the hosted tests below were submitted from the Mac, not from Instinct.

## Local evidence

Verification uses real disposable PostgreSQL clusters, the actual versioned migrations, a restricted runtime database login, a Next.js HTTP server and a separate worker process. It covers:

- Original-schema upgrade preserves a job and revokes legacy temporary credentials.
- New key IDs, names, prefix, SHA-256 hash, scope set, 30-day default, configurable expiry, revocation, last-used timestamp and safe CLI output.
- Ordinary roles cannot access private keys/functions; runtime can validate a hash but cannot read/administer the API-key table or migration history.
- Authenticated creation, own-job reads, idempotent submission, separate Instinct/worker scopes and denial of expired/revoked/invalid keys.
- Concurrent atomic claims, `SKIP LOCKED`, token/worker fencing, progress, completion/failure, terminal report retries and attempt exhaustion.
- Worker journal recovery after network loss/restart, stale lease rejection and lost completion responses.
- Real HTTP submission, a separately running worker's simulated completion, result retrieval and key rotation/revocation.
- Remote DB connections require verified TLS; unsafe URL SSL overrides and non-loopback HTTP origins are rejected.

Verified on November 4, 2026 with Node **24.22.2**, matching the declared Vercel 24.x runtime:

| Check                                                                 | Result                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `node --import tsx --test tests/*.test.ts` (same suite as `npm test`) | 27 reported tests passed, 0 failures                                                    |
| `next build` (`npm run build`)                                        | Passed; dynamic `/` JSON route and `/api/[...path]`, no dashboard                       |
| `tsc --noEmit` (`npm run typecheck`)                                  | Passed                                                                                  |
| `git diff --check`                                                    | Passed                                                                                  |
| `npm audit --omit=dev`                                                | 0 reported vulnerabilities at verification time                                         |
| Secret/state ignore checks                                            | Admin env, key files, runtime connection, local database and worker journal are ignored |

The real worker-process test deliberately dropped its first report's HTTP connection. The worker logged a retry, resumed the saved claim and completed the simulation through the restricted login. The admin/runtime test also authenticated with the generated runtime password and confirmed its 10-second role-level statement timeout. No cloud credentials were used for these tests.

The earlier host-default Node 26 is not the deployment target. The final Instinct acceptance result remains pending.

## Hosted evidence

- API domain: **https://conduit-poc.vercel.app**.
- Vercel deployment `dpl_F7yU2RiY6muXXQsf1g1ESGdprtpe`: **READY**, production POC domain, Node 24, region `iad1`. Source uploads were restricted to the 13 runtime/build files; no env files, keys, database files, worker state, logs, tests or administrator scripts were uploaded.
- Supabase PostgreSQL **17.11.0.011**, region `us-east-1`. Runtime connected to the transaction pooler with verified TLS using the official Supabase CA from the project's SSL-settings certificate link.
- Anonymous `GET /api/jobs`: application JSON **401**, rather than an upstream login page.
- Smoke probe submitted the same request twice and confirmed the same job ID: `b9a07145-93f5-46a0-b97c-966ec56e1871`. The separate Mac worker completed it as `mac-worker`, attempt **1**, at `2026-11-04T23:42:36.549Z`, with `simulated: true`. A direct Supabase query confirmed the stored row and result.
- Hosted temporary-network-failure probe: job `06caad3f-ce10-4f88-bb69-4f79db7a8766` completed as `hosted-recovery-probe`, attempt **1**, at `2026-11-04T23:44:13.002Z`. A loopback test proxy deliberately dropped its first report connection while forwarding other requests to the real Vercel API. The actual worker process logged a retry and resumed its journal. Its temporary test credential was revoked and its delivery file removed afterward.
- Hosted auth checks passed: Instinct cannot claim (403); worker cannot browse (403); invalid, expired and revoked credentials are denied (401); valid credentials work (200); revocation affects the next request while a replacement key stays valid. Submitter responses exclude claim tokens. All temporary auth-test keys were revoked after the checks.
- Runtime database login cannot read API keys or migration history. Key administration uses a distinct `conduit_key_admin` connection; only hashes enter Supabase. Permanent Instinct and worker keys are separate and expire December 4, 2026; neither was printed in chat or logs.
- Supabase security advisor reported only **INFO: RLS enabled with no policies** for private `conduit_meta.schema_migrations`. This is intentional owner-only/default-deny metadata; ordinary roles and the runtime are denied. No permissive policy was added to suppress the informational notice. [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- Vercel's runtime-log API returned **403** for the connection; log-level post-deployment auditing could not be completed through that connector. This is an observability limitation, not a functional-test failure. No claim of a clean Vercel runtime-error scan is made.

The normal `mac-worker` is running against the hosted stable domain with `.secrets/worker-hosted.json` and `.worker/hosted-mac-worker`. Instinct must securely replace its old hourly secret with the token from `.secrets/instinct-hosted.json`, then repeat POST/GET against the Vercel domain before the new external loop can be marked fully accepted.

## Health and authentication endpoint update

Added public `GET /health` (API and queue-database readiness, 200/503) and protected `GET /auth-check` (live key validation plus both Instinct scopes, 200/401/403/503). Local integration tests cover the real HTTP routes, worker/read-only denial, expired/revoked/invalid credentials and sanitized unavailable responses. All 27 tests, production build and TypeScript checks passed.

Vercel deployment `dpl_Fsr1LexKJHhrkXGepfxhYfbvjq99` reached READY at the same stable domain. Live checks passed: `/health` 200 with database ok; `/auth-check` 200 for the Instinct key, 401 without a key or with an invalid key, and 403 with authenticated=true/instinct_access=false for the worker key. No credential was returned.
