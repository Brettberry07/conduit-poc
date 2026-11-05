# Acceptance tests

Hosted API/worker connectivity, authentication and network-recovery checks passed on November 4, 2026. See `verification.md` for job IDs and scope. Instinct must still run the new external POST/GET acceptance test using its new key.

## Local automated gate

Use Node 24.x. Run `npm ci`, `npm test`, `npm run build`, and `npm run typecheck` before approving hosted changes. Tests use disposable PostgreSQL databases and restricted runtime connections. They verify original-schema upgrade preserves a job, revokes legacy keys, and records repeatable migration history; key authenticity/expiration/revocation/scopes/last-used; public-role denial; administrator CLI generation/list/revocation; concurrent claiming, row-lock skipping, worker ownership, terminal idempotency, lease expiry and three-attempt exhaustion; journal recovery after network failure and a lost completion response; and a real Next.js HTTP request processed by a separately spawned worker.

## Hosted acceptance

1. Confirm the Vercel stable domain returns the Conduit JSON service identifier at `/`. There must be no dashboard. Anonymous `GET /api/jobs` returns JSON 401.
2. Start the Mac worker using the hosted API URL, private worker file and a new hosted state directory. No database variables should be needed by this process.
3. Run `npm run smoke` with `CONDUIT_API_URL` and `SUBMITTER_KEY_FILE`. It should return completed / simulated true and the same job ID for repeated idempotent submissions. Inspect that row in the dedicated Supabase project: status, result, worker, attempt count and timestamps must match.
4. From Instinct, run the POST/GET procedure in `instinct.md`. Capture actual status codes and result without credentials. This is the external acceptance gate.
5. Submit `simulate-failure` under another request UUID. Expect `failed`, `Predefined simulated failure`, and a completion timestamp.
6. Temporarily interrupt the worker's network access during progress, leaving Vercel/Supabase running. Logs should show retries without credential/claim-token content. Restore access promptly: it should renew the valid claim and finish. Leave it disconnected for over 30 seconds and restore: it should reject the expired saved claim, reacquire eligible work with a new token and attempt count, and finish. No external side effects should occur.
7. Ctrl-C during a simulation, then restart with the same URL, worker principal and state directory. It should resume safely. To test a crash, terminate the worker abruptly, verify its recorded PID is gone and remove only its lock file; preserve journal and origin. Restart before/after lease expiry. Never remove a live process's lock.
8. For concurrent-claim behavior, create a second worker key with a **different principal** and separate state directory. Queue several simulations. Each unexpired claim has one owner. Use automated PostgreSQL tests for the deterministic locked-row/stale-token cases; do not send raw claim tokens through chat.
9. Use a worker credential on `POST /api/jobs` or `GET /api/jobs`: expect 403. Another Instinct principal must get an empty own-job list and 404 for the first principal's job ID. Missing/random/expired/revoked keys get 401.
10. Rotate Instinct's key with the same principal. The new key must retrieve prior results. Revoke the old key ID and verify its next request gets 401, while the new key remains valid. Listing must show prefix/metadata only, not plaintext/hashes.
11. Rotate the worker key with the same principal, preserving hosted state. Revoke the old worker key after validating the replacement. A worker using the revoked key stops on 401.
12. Confirm the runtime database login cannot SELECT/INSERT/UPDATE/DELETE API keys, access migration history, create roles or databases, or bypass RLS. Ordinary Supabase `anon` and `authenticated` roles cannot access the private schemas or authentication function. Run Supabase security advisors and review any findings in the new project only.
13. Inspect Vercel/runtime logs and worker logs without exporting sensitive request headers. Confirm no bearer key, claim token, admin URL, or database password appears. Stop the old tunnel/local API/database only after hosted acceptance passes; preserve old data for rollback evidence.

## Interpreting failures

- JSON 401: missing, malformed, expired, revoked, or unregistered key. Confirm the key and API use the same dedicated database.
- JSON 403: valid key lacks the required scope. Instinct and worker keys are intentionally different.
- JSON 409 on worker reports: lease expired, token stale, or worker mismatch; journal recovery should handle it.
- Vercel HTML/redirect instead of JSON: deployment access/protection is intercepting requests.
- JSON 500: check sanitized Vercel function logs, runtime DB permissions, pooler custom-role username, verified TLS/CA, and migrations. Do not print connection strings or request headers.
- Worker marked offline after 15 seconds: heartbeat is stale. A running job becomes reclaimable after 30 seconds, and the next polling worker performs cleanup/reclaim.
