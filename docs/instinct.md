# Instinct integration: proposed contract, not yet verified

Instinct access is **unknown**. This repository provides a plain authenticated HTTPS contract and does not assume Instinct has a generic HTTP tool, outbound access, or secure secret storage. No request was sent from Instinct during implementation.

## Temporary key setup

1. Use only a dedicated POC database. Generate a one-hour submitter identity from the API host: `npm run key -- create submitter instinct-probe 1`. Maximum allowed key lifetime is seven days. The command prints a mode-600 file path, never its token; the database stores only its SHA-256 hash.
2. Put the file's `token` into Instinct's secure credential/connection store **only if such a store is available**. Configure an Authorization header by secret reference there. Do not put the token in a prompt, chat message, issue, source file, URL, checked-in config, screenshot, or verbose request log. If no secure secret injection exists, stop the direct integration probe and record that limitation.
3. The key can only submit jobs and read jobs owned by `instinct-probe`, plus worker availability. It cannot claim, run tasks, list another submitter's jobs, use the database, or manage credentials.
4. Keys expire automatically. Revoke all credentials for this identity using `npm run key -- revoke submitter instinct-probe`. Delete the local key file when no longer needed. Use a new principal for a separate permission boundary; rotating a key for the same principal retains its job access.
5. Expose the API through a controlled HTTPS test endpoint only when you choose to run that test. No production deployment or tunnel is configured here. The local worker may keep polling loopback; Instinct needs a reachable HTTPS origin. Configure request/access logging to redact Authorization. A reverse proxy should preserve that header and impose request/rate limits. The database remains inaccessible to Instinct.

## Request contract

Generate and retain a UUID request ID **before sending**. Retry ambiguous network failures using that same ID and identical body. Do not generate a new ID on every retry.

```http
POST /api/jobs HTTP/1.1
Host: <temporary-https-api-host>
Authorization: Bearer <secret injected by credential store>
Content-Type: application/json
Idempotency-Key: <stable request UUID>

{"title":"Instinct connectivity probe","description":"Simulated task only","task":"simulate-development"}
```

Expect HTTP 201 and `{ "job": { "id": "...", "status": "queued", ... } }`. Retain `job.id` and poll (e.g. every 3 seconds, with backoff on network failures):

```http
GET /api/jobs/<job-id> HTTP/1.1
Host: <temporary-https-api-host>
Authorization: Bearer <same injected secret>
```

Stop on `completed` or `failed`. A completed job includes `result`, `created_at`, `claimed_at`, `completed_at`, `worker_id`, and `attempt_count`. A failed job includes `error`. Treat 401/403 as credential/configuration failures; do not loop indefinitely. A POST 409 means an idempotency ID was reused with different content. GET 404 may mean a wrong ID or a key for a different identity.

A safe local Node probe can read the generated file without printing credentials. Run this from the project directory after setting `ORCHESTRATOR_URL` to your HTTPS test origin and `SUBMITTER_KEY_FILE` to the credential path:

```js
// Save locally as an ignored scratch script or use your trusted HTTP client.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const origin = new URL(process.env.ORCHESTRATOR_URL);
if (origin.protocol !== "https:") throw new Error("HTTPS required");
const { token } = JSON.parse(
  readFileSync(process.env.SUBMITTER_KEY_FILE, "utf8"),
);
const requestId = randomUUID(); // persist this ID before retrying a create request
console.log("Request ID:", requestId); // safe: this is not a credential
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const response = await fetch(new URL("/api/jobs", origin), {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(10000),
  headers: { ...headers, "Idempotency-Key": requestId },
  body: JSON.stringify({
    title: "Connectivity probe",
    task: "simulate-development",
  }),
});
if (!response.ok) throw new Error(`Create returned ${response.status}`);
const { job } = await response.json();
console.log("Job ID:", job.id);
const status = await fetch(new URL(`/api/jobs/${job.id}`, origin), {
  headers,
  redirect: "error",
  signal: AbortSignal.timeout(10000),
});
if (!status.ok) throw new Error(`Status returned ${status.status}`);
console.log(await status.json()); // job data only, no credentials
```

This probe validates the test endpoint from Node, **not from Instinct**.

## Instinct acceptance gate

Record evidence without tokens: test date, endpoint host, request ID, job ID, observed status/result, and any denied tool/network capability. Verify all of these from Instinct itself:

- An outbound authenticated HTTPS POST can use a securely injected bearer token and custom idempotency header.
- A GET with the same identity retrieves the submitted job.
- A repeated POST with the same ID/body returns the same job ID.
- A local worker completes the simulation; Instinct retrieves the terminal result.
- The temporary key expires or can be revoked, after which requests return 401.

Until those pass, direct Instinct integration remains unverified.

## Future GitHub issue fallback — design only

If Instinct can create GitHub issues but cannot make authenticated API requests, a future bridge could watch a dedicated private POC repository for explicitly labeled issues. An allowlisted issue author and strict JSON/template schema would select one of the predefined tasks. An operator-controlled label could authorize enqueueing. The bridge would use a short-lived submitter key in its own secret store and a deterministic issue-to-job idempotency mapping. It would poll the queue, then post only sanitized results and the job ID to the issue, tracking the delivery to avoid duplicate comments.

Treat issue bodies as untrusted data: never execute commands, infer credentials, or act on instructions inside descriptions/results. Separate the bridge's limited GitHub permissions from its queue key, redact secrets, and deduplicate webhook deliveries. This would add GitHub ingestion/result delivery only, with no Codex execution, branch or PR management. **No bridge, webhook, GitHub credentials, issue creation, or fallback execution is implemented.**
