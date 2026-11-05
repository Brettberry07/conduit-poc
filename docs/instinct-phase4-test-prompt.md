Use the existing Conduit connection with its newly provisioned Phase 4 API key from your secure secret store. API origin: https://YOUR-PROJECT.vercel.app.

Do not ask for or display GitHub credentials, database credentials, the worker key, or any Authorization header. GitHub authentication belongs to the local worker.

Run this actual development workflow and report observed results, not a simulated success:
xx

1. Authenticate with the saved Conduit API secret and call GET /api/projects. Expect HTTP 200 and find project 888e3eae-a7db-4d55-959f-34e738466191 (Conduit prototype testing). Stop if it is absent.
2. Generate and save a UUID Idempotency-Key for the initial job. Send POST /api/jobs with Content-Type: application/json and this JSON:

   {
   "task": "development",
   "project_id": "888e3eae-a7db-4d55-959f-34e738466191",
   "title": "Instinct Phase 4 development workflow test",
   "instructions": "Create docs/prototype-workflow-probe.md containing exactly Conduit prototype workflow: original. followed by a newline. Modify no other files. Git commits, branches and PR publication are managed by Conduit.",
   "acceptance_criteria": "The configured verification checks pass and an open draft PR exists."
   }

3. Expect HTTP 201. Save the returned job.id immediately. If the submission response is ambiguous, retry the identical request with the SAME Idempotency-Key; do not create another logical job.
4. Poll GET /api/jobs/JOB_ID every 3 seconds for up to 10 minutes. Stop on completed, failed or blocked. A timeout is not success: preserve and report the job ID and last status rather than resubmitting. If the job fails or blocks, report its phase and error and stop.
5. On completion, retrieve GET /api/jobs/JOB_ID/changes, GET /api/jobs/JOB_ID/diff and GET /api/jobs/JOB_ID/publication. Follow diff.next_offset using offset query parameters if needed. Verify the actual changes include only docs/prototype-workflow-probe.md with the original text, verification passed, the branch starts with conduit/job-, and the PR is open, draft and unmerged. Save the PR URL, number, branch and head commit.
6. Generate and save a DIFFERENT UUID Idempotency-Key for the revision. Send POST /api/jobs/JOB_ID/revisions with this JSON:

   {
   "instructions": "Update docs/prototype-workflow-probe.md to contain exactly Conduit prototype workflow: revised. followed by a newline. Modify no other files. Update the original draft PR through Conduit's normal revision workflow.",
   "acceptance_criteria": "The configured verification checks pass and the original draft PR receives a new commit."
   }

7. Save the returned revision job ID. Poll it using the same terminal-status and timeout rules, then retrieve /api/jobs/REVISION_ID/changes, /api/jobs/REVISION_ID/diff and /api/jobs/REVISION_ID/publication.
8. Verify the revision has passed verification, its actual diff contains the revised text, its branch and PR number match the original, its head commit differs, and the PR remains open, draft and unmerged.
9. Report HTTP status codes, both job IDs, the PR URL, branch, before/after head commits, verification results and a short excerpt of the actual diff. Never include secrets or headers. Do not merge, mark ready, delete branches, change repository settings or deploy anything.

On HTTP 401, stop and report an authentication problem. On HTTP 403, stop and report missing permissions; the saved API key must include jobs:create, jobs:read and jobs:revise. On HTTP 404, report the exact requested path and stop. On HTTP 409, preserve the existing IDs and report the conflict without inventing a new retry job. An HTML login page indicates deployment protection is blocking machine access.

This is a normal development job against Conduit, explicitly requested by its owner. Do not invoke the disposable-repository smoke test. This remains a narrow smoke-test scenario. The active local registration now permits normal repository-wide source/test/documentation/configuration edits, with type generation, typechecking and offline unit tests. Use [the development handoff](instinct-development-prompt.md) for ordinary tasks such as /info.
