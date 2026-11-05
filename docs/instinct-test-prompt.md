Test Conduit POC using actual HTTPS requests. Base URL:
https://conduit-poc.vercel.app

Use the new saved 30-day Conduit key through secure secret injection. Never print the key, Authorization header, or credential-store contents. If secure secret injection or custom-header HTTP requests are unavailable, stop and report that limitation. Do not claim success without making the requests.

1. GET /health without credentials.
   Expect HTTP 200, status="ok", database="ok". Stop on 503.

2. GET /auth-check with:
   Authorization: Bearer <securely injected saved key>
   Expect HTTP 200, authenticated=true, instinct_access=true,
   permissions.create_jobs=true and permissions.read_jobs=true.
   Stop on 401, 403 or 503; report the sanitized response/status.

3. GET /api/workers using the same Authorization header.
   Report whether mac-worker is available. If offline, stop before submitting and explain that the Mac worker needs to be started.

4. Generate and retain a fresh UUID for this logical job. Send:
   POST /api/jobs
   Authorization: Bearer <same securely injected key>
   Content-Type: application/json
   Idempotency-Key: <retained UUID>

   Exact JSON body:
   {"title":"Instinct hosted connectivity test","description":"Verify Vercel, Supabase, and Mac worker communication","task":"simulate-development"}

   Expect HTTP 201. Save the returned job.id.
   For an ambiguous timeout, retry at most twice using the same UUID and identical body. Never create a new UUID for a retry.

5. GET /api/jobs/<returned-job-id> with the same Authorization header.
   Poll every 3 seconds for up to 60 seconds. Stop on completed or failed.
   Success requires completed and result.simulated=true.
   If polling times out, retain the job ID and report the last status; do not submit another job.

6. Report only actual observations:
   - HTTP status codes for health, auth-check, submission, and final retrieval.
   - Worker availability.
   - Request UUID and job ID.
   - Final status, result or error, worker_id, attempt_count, completed_at.
   - Which steps actually ran and any step that could not be performed.

Do not revoke or rotate the saved key, change settings, invoke Codex, contact GitHub, or execute shell commands. This is a predefined simulation only.
