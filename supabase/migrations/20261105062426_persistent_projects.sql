-- Phase 4 is additive. Projects are administrator-owned; no registration HTTP API.
CREATE TABLE orchestrator.projects (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 repository_owner text NOT NULL CHECK(repository_owner ~ '^[A-Za-z0-9-]+$'),
 repository_name text NOT NULL CHECK(repository_name ~ '^[A-Za-z0-9_.-]+$'),
 repository_url text NOT NULL, default_branch text NOT NULL,
 allowed_base_branches text[] NOT NULL, enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(repository_owner,repository_name), CHECK(default_branch=ANY(allowed_base_branches))
);
ALTER TABLE orchestrator.jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE orchestrator.jobs ADD CONSTRAINT jobs_task_check CHECK(task IN ('simulate-development','simulate-failure','codex_task','development'));
ALTER TABLE orchestrator.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE orchestrator.jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','waiting_dependencies','running','completed','failed','blocked'));
-- Retain running/lease equivalence and extend terminal timestamp equivalence.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='orchestrator.jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%completed_at%' LOOP
 EXECUTE format('ALTER TABLE orchestrator.jobs DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE orchestrator.jobs ADD CHECK((status IN ('completed','failed','blocked'))=(completed_at IS NOT NULL));
ALTER TABLE orchestrator.jobs ADD COLUMN project_id uuid REFERENCES orchestrator.projects,
 ADD COLUMN root_job_id uuid REFERENCES orchestrator.jobs,
 ADD COLUMN base_branch text, ADD COLUMN dependency_job_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN phase text CHECK(phase IN ('claimed','running','verifying','publishing')),
 ADD CHECK(task<>'development' OR (project_id IS NOT NULL AND root_job_id IS NOT NULL AND instructions IS NOT NULL AND base_branch IS NOT NULL));
CREATE TABLE orchestrator.development_tasks (
 job_id uuid PRIMARY KEY REFERENCES orchestrator.jobs, project_id uuid NOT NULL REFERENCES orchestrator.projects,
 branch text NOT NULL, base_branch text NOT NULL, base_commit text, head_commit text,
 pull_request jsonb, publication_state text NOT NULL DEFAULT 'pending',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(project_id,branch)
);
CREATE UNIQUE INDEX one_active_branch ON orchestrator.jobs(root_job_id) WHERE task='development' AND status='running';
CREATE TABLE orchestrator.execution_attempts (
 job_id uuid NOT NULL REFERENCES orchestrator.jobs, attempt integer NOT NULL,
 status text NOT NULL, starting_commit text, result jsonb, error text,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 PRIMARY KEY(job_id,attempt)
);
CREATE TABLE orchestrator.change_artifacts (
 job_id uuid NOT NULL, attempt integer NOT NULL, kind text NOT NULL CHECK(kind IN ('execution','pull_request')),
 files jsonb NOT NULL, diff text NOT NULL CHECK(octet_length(diff)<=160000),
 PRIMARY KEY(job_id,attempt,kind), FOREIGN KEY(job_id,attempt) REFERENCES orchestrator.execution_attempts
);
CREATE FUNCTION orchestrator.record_execution_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.task='development' AND NEW.attempt_count>OLD.attempt_count THEN
  UPDATE orchestrator.execution_attempts SET status='interrupted',completed_at=clock_timestamp(),error='Lease expired; recovery attempt claimed'
   WHERE job_id=NEW.id AND completed_at IS NULL;
  INSERT INTO orchestrator.execution_attempts(job_id,attempt,status) VALUES(NEW.id,NEW.attempt_count,'running');
 ELSIF NEW.task='development' AND NEW.status IN ('completed','failed','blocked') THEN
  UPDATE orchestrator.execution_attempts SET status=NEW.status,result=NEW.result,error=NEW.error,completed_at=NEW.completed_at
   WHERE job_id=NEW.id AND attempt=NEW.attempt_count AND completed_at IS NULL;
 END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orchestrator.record_execution_attempt() FROM PUBLIC;
CREATE TRIGGER record_execution_attempt AFTER UPDATE ON orchestrator.jobs FOR EACH ROW EXECUTE FUNCTION orchestrator.record_execution_attempt();
ALTER TABLE orchestrator.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.development_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.change_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orchestrator.projects,orchestrator.development_tasks,orchestrator.execution_attempts,orchestrator.change_artifacts FROM PUBLIC;
GRANT SELECT ON orchestrator.projects TO conduit_api;
CREATE POLICY runtime_projects ON orchestrator.projects FOR SELECT TO conduit_api USING(true);
GRANT SELECT,INSERT,UPDATE ON orchestrator.development_tasks,orchestrator.execution_attempts,orchestrator.change_artifacts TO conduit_api;
CREATE POLICY runtime_tasks ON orchestrator.development_tasks TO conduit_api USING(true) WITH CHECK(true);
CREATE POLICY runtime_attempts ON orchestrator.execution_attempts TO conduit_api USING(true) WITH CHECK(true);
CREATE POLICY runtime_artifacts ON orchestrator.change_artifacts TO conduit_api USING(true) WITH CHECK(true);
-- Preserve old scopes. New keys opt into revision writes; existing read scopes can read projects/reviews.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='orchestrator.api_keys'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%scopes%' LOOP
 EXECUTE format('ALTER TABLE orchestrator.api_keys DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE orchestrator.api_keys ADD CHECK(cardinality(scopes)>0 AND array_position(scopes,NULL) IS NULL AND
 ((role='submitter' AND scopes <@ ARRAY['jobs:create','jobs:read','jobs:revise']::text[]) OR
 (role='worker' AND scopes <@ ARRAY['jobs:claim','jobs:update']::text[])));
