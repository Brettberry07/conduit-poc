-- Additive Phase 5B. No execution records are copied or rewritten.
CREATE TABLE orchestrator.initiatives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text NOT NULL,
 project_id uuid NOT NULL REFERENCES orchestrator.projects,
 request_id uuid NOT NULL, creation_content jsonb NOT NULL,
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND octet_length(plan::text)<=786432),
 plan_version integer NOT NULL DEFAULT 1 CHECK(plan_version>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed','cancelled')),
 activation_request_id uuid, activation_content jsonb, activated_at timestamptz,
 completed_at timestamptz, completion_summary text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,request_id), UNIQUE(owner,activation_request_id), UNIQUE(id,owner), UNIQUE(id,owner,project_id),
 CHECK((status='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX initiatives_owner_updated ON orchestrator.initiatives(owner,updated_at DESC,id);
CREATE TABLE orchestrator.initiative_plan_versions (
 initiative_id uuid NOT NULL, owner text NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, explanation text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(initiative_id,version), FOREIGN KEY(initiative_id,owner) REFERENCES orchestrator.initiatives(id,owner)
);
ALTER TABLE orchestrator.jobs ADD CONSTRAINT jobs_owner_project UNIQUE(id,submitter_id,project_id);
ALTER TABLE orchestrator.jobs ADD CONSTRAINT jobs_family_owner UNIQUE(id,root_job_id,submitter_id);
CREATE TABLE orchestrator.initiative_tasks (
 initiative_id uuid NOT NULL, task_key text NOT NULL CHECK(task_key ~ '^[a-z][a-z0-9-]{0,63}$'),
 owner text NOT NULL, project_id uuid NOT NULL, spec jsonb NOT NULL, display_order integer NOT NULL,
 root_job_id uuid UNIQUE REFERENCES orchestrator.development_tasks(job_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(initiative_id,task_key), UNIQUE(initiative_id,task_key,root_job_id,owner),
 FOREIGN KEY(initiative_id,owner,project_id) REFERENCES orchestrator.initiatives(id,owner,project_id),
 FOREIGN KEY(root_job_id,owner,project_id) REFERENCES orchestrator.jobs(id,submitter_id,project_id)
);
CREATE TABLE orchestrator.initiative_dependencies (
 initiative_id uuid NOT NULL, task_key text NOT NULL, dependency_key text NOT NULL,
 PRIMARY KEY(initiative_id,task_key,dependency_key), CHECK(task_key<>dependency_key),
 FOREIGN KEY(initiative_id,task_key) REFERENCES orchestrator.initiative_tasks,
 FOREIGN KEY(initiative_id,dependency_key) REFERENCES orchestrator.initiative_tasks
);
CREATE INDEX initiative_dependency_targets ON orchestrator.initiative_dependencies(initiative_id,dependency_key);
CREATE INDEX jobs_root_history ON orchestrator.jobs(root_job_id,created_at DESC,id DESC);
CREATE TABLE orchestrator.initiative_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), initiative_id uuid NOT NULL, task_key text NOT NULL,
 owner text NOT NULL, root_job_id uuid NOT NULL, job_id uuid NOT NULL,
 request_id uuid NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,request_id),
 FOREIGN KEY(initiative_id,task_key,root_job_id,owner) REFERENCES orchestrator.initiative_tasks(initiative_id,task_key,root_job_id,owner),
 FOREIGN KEY(job_id,root_job_id,owner) REFERENCES orchestrator.jobs(id,root_job_id,submitter_id)
);
CREATE INDEX initiative_reviews_history ON orchestrator.initiative_reviews(initiative_id,created_at DESC,id);
CREATE INDEX initiative_reviews_task_history ON orchestrator.initiative_reviews(initiative_id,task_key,created_at DESC,id DESC);
-- An explicit observation timestamp: updated_at also changes on local publication steps.
ALTER TABLE orchestrator.development_tasks ADD COLUMN pull_request_observed_at timestamptz;
-- Existing observations have unknown observation times; do not backfill fabricated freshness.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['initiatives','initiative_tasks','initiative_dependencies','initiative_plan_versions','initiative_reviews'] LOOP
  EXECUTE format('ALTER TABLE orchestrator.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON orchestrator.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON orchestrator.%I TO conduit_api',t);
  -- Same trusted-server boundary as jobs. No anon/authenticated schema access.
  EXECUTE format('CREATE POLICY runtime_initiatives ON orchestrator.%I TO conduit_api USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT UPDATE ON orchestrator.initiatives,orchestrator.initiative_tasks TO conduit_api;
GRANT DELETE ON orchestrator.initiative_tasks,orchestrator.initiative_dependencies TO conduit_api;
