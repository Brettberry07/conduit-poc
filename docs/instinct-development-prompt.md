Conduit's worker configuration has been upgraded from the probe-only test profile to normal repository development. The old docs/prototype-workflow-probe.md restriction and its content check are removed. Do not refuse source-code work based on that earlier configuration.

Use the existing Conduit connection and its API key from your secure secret store:

- API origin: https://YOUR-PROJECT.vercel.app
- Project ID: 888e3eae-a7db-4d55-959f-34e738466191
- Repository: Brettberry07/conduit-poc

You may create and modify normal source files, tests, documentation, configuration and package manifests throughout this registered repository. Choose the files needed for the user's task; there is no task-specific source-file allowlist. Environment files (`.env`, `.env.*`) and `.ssh` directories are blocked. Git inspection, writable per-worktree dependencies, generated output and GitHub workflow edits are allowed. Worker authentication and controller configuration outside the worktree remain private. Code execution stays in an isolated worktree; the worker manages commits and publication. No automatic merging or deployment.

Please submit the user's requested development task now:

Implement a GET /info endpoint for Conduit. It should explain what Conduit does and its current capabilities, so a person can open it in a browser or an assistant can retrieve it. Describe job submission/tracking, local Codex execution, Git worktree isolation, actual diff retrieval, draft PR creation, same-PR revisions and human-controlled review/merge/deployment. Keep claims consistent with the actual implementation. Do not return secrets, credential values, local paths or private job data. Add appropriate tests and documentation. Choose the response format and implementation details that fit this application.

The worker runs Next route-type generation, TypeScript checking and offline unit tests. New tests/*.test.ts, *.test.tsx, *.test.js, *.test.mjs and *.test.cjs files are discovered automatically. Existing tests that require Git subprocesses, database/network services, real Codex or the credential subprocess harness run separately outside job verification. Existing dependencies are copied into each worktree and are writable there. Package manifests and lockfiles may change. The sandbox remains offline: if a new package is unavailable locally, report the required preparation rather than claiming installation succeeded. Failed check results include bounded, redacted diagnostics.

Submit POST /api/jobs with task="development", the project ID above, a clear title, the task instructions and acceptance criteria. Use the saved API key in Authorization and a saved UUID Idempotency-Key. Retry an ambiguous submission with the identical body and same UUID. Save the returned job ID immediately.

Poll GET /api/jobs/JOB_ID until completed, failed or blocked. Allow up to ten minutes; preserve the ID on timeout. On completion retrieve /changes, /diff and /publication, following diff pagination when needed. Report actual verification results, changed files and the draft PR URL. On failure/block report the phase and error. Do not create duplicate jobs to bypass a failure.

If a revision is needed, POST /api/jobs/JOB_ID/revisions with its own stable UUID Idempotency-Key. Verify the same branch/PR receives a new commit. Never display credentials or Authorization headers, mark the PR ready, merge it, change repository settings or deploy the endpoint. /info becomes live only after the owner approves merging and deployment.
