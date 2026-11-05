-- Additive: retain existing simulation contracts and lease fencing.
ALTER TABLE orchestrator.jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE orchestrator.jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('simulate-development','simulate-failure','codex_task'));
ALTER TABLE orchestrator.jobs
  ADD COLUMN instructions text CHECK(length(instructions) BETWEEN 1 AND 12000),
  ADD COLUMN acceptance_criteria text CHECK(length(acceptance_criteria)<=4000),
  ADD COLUMN project text,
  ADD CONSTRAINT jobs_codex_input_check CHECK (
    task <> 'codex_task' OR (instructions IS NOT NULL AND project IS NOT NULL AND project='typescript-sandbox'));
-- Execution metadata, verification, changed files and public attempt ID live in result JSONB,
-- including failures. claim_token remains private and fences every report.
