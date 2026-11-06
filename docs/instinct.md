# Instinct: 30-day key setup, requests and rotation

The earlier Cloudflare/local-PostgreSQL communication loop was verified by Instinct. The new Vercel/Supabase loop is deployed and verified from the Mac worker. A request from Instinct itself is still the final external acceptance gate. Use **https://YOUR-PROJECT.vercel.app** and the new `.secrets/<submitter-key>.json` delivery file; the earlier hourly key is not registered in this hosted database.

## Phase 5A protocol

For the reusable development protocol, use the [Phase 5A contract and staged rollout](phase-5a-agent-protocol.md) and give Instinct the [short standing instruction](instinct-standing-instruction.md) once. The authenticated manifest is authoritative for PM behavior after this release is installed; the task-specific prompts below remain historical handoffs. Hosted deployment and real Instinct adoption require separate acceptance.

## Phase 4 handoff

The hosted API and Mac worker now support registered development jobs and same-PR revisions. For Phase 4 use `.secrets/<phase4-key>.json` instead of the earlier delivery file; it has create/read/revise scopes and the same `instinct` principal. The older key remains active during handoff. Run `/Users/YOU/.conduit/hosted/copy-api-key.sh` locally, paste into Instinct's secure secret field, and send [the prepared Phase 4 test prompt](instinct-phase4-test-prompt.md). No GitHub or database credential belongs in Instinct.

## Normal development tasks

The current worker registration permits normal source, test, documentation and configuration changes throughout the registered repository. It is no longer limited to the probe document. Verification uses Next route types, TypeScript and offline unit tests; existing dependencies are shared read-only. Credentials, Git metadata, generated output, dependency stores and GitHub workflow files retain mandatory protections. Work stays on feature branches/draft PRs, with human merge/deployment. Use [the development handoff](instinct-development-prompt.md) to submit the requested /info task.

## Secure key provisioning

The initial hosted key is already generated in `.secrets/<submitter-key>.json` and expires December 4, 2026. Do not generate another key merely to finish the first test. Copy its token privately:

```sh
node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).token)' .secrets/<submitter-key>.json | pbcopy
```

Paste only into Instinct's secure secret field, then clear the clipboard. Use `https://YOUR-PROJECT.vercel.app` as the API origin. The rest of this section describes generating future replacements.

On the administrator's Mac, with `.env.admin.local` pointing only to the dedicated Supabase POC project:

```sh
npm run key -- create --type instinct --principal instinct --name "Instinct primary" --out .secrets/instinct.json
```

This generates a 256-bit random `cnd_live_...` credential with a 30-day expiration and scopes `jobs:create`, `jobs:read`. The private JSON file is mode 600 and ignored by version control/deployment uploads. Only the hash, short prefix and metadata enter Supabase. Alternatively omit `--out` in an interactive terminal to display the plaintext once. No later listing or API response can retrieve it.

Transfer its `token` value into Instinct's secure secret/connection store. Never put it in conversation, source, an issue, URLs, screenshots or verbose HTTP logs. To copy the value on macOS without printing it:

```sh
node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).token)' .secrets/instinct.json | pbcopy
```

Paste it only into the secure secret field, then clear the clipboard with `printf '' | pbcopy`. Store a backup in a password manager if needed; protect or delete the local delivery file after secure transfer. Instinct's saved secret can be reused for future requests until expiration or revocation; no hourly renewal is needed. Do not give Instinct the worker key or any database credentials.

Configure a secret-injected header:

```text
Authorization: Bearer <saved Instinct API key>
```

The API has no login/OAuth/account flow. Instinct must support HTTPS and custom headers with secure secret injection. If those are unavailable, stop and report the limitation. The GitHub-issue fallback remains design-only; no fallback bridge or GitHub integration is implemented.

## Submission and result retrieval

Use the stable approved Vercel domain. Generate a **new UUID for each new logical job**, and persist it before submitting. Retry an ambiguous response with the same UUID and identical body:

```http
POST https://YOUR-PROJECT.vercel.app/api/jobs
Authorization: Bearer <securely injected key>
Content-Type: application/json
Idempotency-Key: <stable UUID for this job>

{"title":"Instinct connectivity test","description":"Verify submission and result retrieval","task":"simulate-development"}
```

Expect HTTP 201 with `{ "job": { "id": "...", "status": "queued", ... } }`. Save `job.id`. Poll every three seconds for up to a minute:

```http
GET https://YOUR-PROJECT.vercel.app/api/jobs/<returned-job-id>
Authorization: Bearer <same securely injected key>
```

Expect HTTP 200. Stop on `completed` or `failed`. A successful simulation includes `job.result.simulated: true`. Report the actual request status codes, job ID, final status/result/error, worker ID, attempt count and completed timestamp—never the key or Authorization header.

If polling times out, preserve the job ID and report the last status instead of creating another job. On 401, stop: the key is missing/invalid/expired/revoked. On 403, stop: scopes are insufficient. On 409 during create, stop: the UUID was reused with different content. A 404 means a wrong path/job or different submitter identity. An HTML Vercel login page means deployment access configuration is blocking the API before application authentication.

## Rotate before expiration

Use `npm run key -- list` to inspect expiration, last-used, key ID and prefix. It never prints a plaintext key or hash. Schedule rotation operationally a few days before expiry; no reminder/automation has been configured.

1. Generate an overlapping replacement using the **same principal**:

   ```sh
   npm run key -- create --type instinct --principal instinct --name "Instinct rotated" --days 30 --out .secrets/instinct-next.json
   ```

2. Replace the saved secret in Instinct through its secure configuration. Future requests authenticate using the replacement.
3. From Instinct, retrieve a previously owned job and submit/complete a new simulation. The same principal preserves access to historical jobs.
4. Revoke the previous key by its unique ID:

   ```sh
   npm run key -- revoke OLD_KEY_UUID
   ```

5. Confirm the old key gets 401 while the new key remains usable. Remove obsolete local plaintext files/password-manager entries as appropriate.

Revocation is checked on each request without a cache; an already authenticated in-flight request may finish. Worker-key rotation uses the same pattern with `--type worker --principal mac-worker`: stop the worker gracefully, update its key file path, restart with the same hosted state directory, test recovery, then revoke the old key.

## Acceptance evidence

Record the Vercel domain, request UUID, job ID, HTTP status codes, final result and timestamp without credentials. Verify the matching row in the dedicated Supabase database. The acceptance loop must be observed from Instinct, not inferred from the local smoke probe. Hosted connectivity, authentication scopes, expiry, revocation and rotation were checked from the Mac. Record Instinct’s actual POST/GET responses separately before claiming that external acceptance gate passed.

## Check readiness and authentication first

1. `GET https://YOUR-PROJECT.vercel.app/health` with no credential: expect 200 and `status: "ok"`, `database: "ok"`.
2. `GET https://YOUR-PROJECT.vercel.app/auth-check` with the saved bearer key: expect 200, `authenticated: true`, and `instinct_access: true`. Both `permissions.create_jobs` and `permissions.read_jobs` must be true. No credential is returned.
3. `GET /api/workers` with the same bearer key: confirm `mac-worker` is available before expecting immediate completion. Offline workers leave jobs queued.
4. Submit and poll the simulation as described above. Only a completed result with `simulated: true` proves the complete loop.

Stop on 401 (credential problem), 403 (insufficient Instinct scopes), or 503 (service unavailable). Do not print Authorization headers or secrets in the report.
