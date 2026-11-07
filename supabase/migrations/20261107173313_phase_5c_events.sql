-- Phase 5C starts recording new transitions. Existing records are untouched.
CREATE TABLE orchestrator.event_cursors (
 owner text PRIMARY KEY,
 last_cursor bigint NOT NULL CHECK(last_cursor > 0)
);
CREATE TABLE orchestrator.events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner text NOT NULL,
 cursor bigint NOT NULL CHECK(cursor > 0),
 type text NOT NULL,
 project_id uuid,
 initiative_id uuid,
 task_key text CHECK(task_key ~ '^[a-z][a-z0-9-]{0,63}$'),
 job_id uuid,
 root_job_id uuid,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=2048),
 schema_version integer NOT NULL DEFAULT 1,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,cursor)
);
CREATE INDEX events_initiative_history ON orchestrator.events(owner,initiative_id,cursor) WHERE initiative_id IS NOT NULL;
CREATE INDEX events_job_history ON orchestrator.events(owner,job_id,cursor) WHERE job_id IS NOT NULL;

CREATE TABLE orchestrator.event_consumers (
 owner text NOT NULL,
 name text NOT NULL CHECK(name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 acknowledged_cursor bigint NOT NULL DEFAULT 0 CHECK(acknowledged_cursor >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 acknowledged_at timestamptz,
 PRIMARY KEY(owner,name)
);

ALTER TABLE orchestrator.event_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.event_consumers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orchestrator.event_cursors,orchestrator.events,orchestrator.event_consumers FROM PUBLIC,conduit_api;
GRANT SELECT ON orchestrator.events,orchestrator.event_consumers TO conduit_api;
GRANT INSERT(owner,name),UPDATE(acknowledged_cursor,acknowledged_at) ON orchestrator.event_consumers TO conduit_api;
CREATE POLICY runtime_event_read ON orchestrator.events FOR SELECT TO conduit_api USING(true);
CREATE POLICY runtime_event_consumers ON orchestrator.event_consumers TO conduit_api USING(true) WITH CHECK(true);

-- New publication writers attach the job holding the fenced lease. NULL also
-- permits old API binaries to keep writing during rollout.
ALTER TABLE orchestrator.development_tasks ADD COLUMN publication_job_id uuid;

CREATE FUNCTION orchestrator.append_event(
 p_owner text, p_type text, p_project uuid, p_initiative uuid, p_task text,
 p_job uuid, p_root uuid, p_data jsonb, once_per_attempt boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE next_cursor bigint;
BEGIN
 -- Deferred producers reach this gate after source writes. A claim sweep can
 -- affect multiple owners, so use one gate before any owner counter locks.
 -- No producer locks or writes source rows from this point on.
 PERFORM pg_advisory_xact_lock(1965161376, 1);
 IF once_per_attempt AND EXISTS (
  SELECT 1 FROM orchestrator.events e
  WHERE e.owner=p_owner AND e.job_id=p_job AND e.type=p_type AND e.data->'attempt'=p_data->'attempt'
 ) THEN
  RETURN;
 END IF;
 INSERT INTO orchestrator.event_cursors AS c(owner,last_cursor) VALUES(p_owner,1)
 ON CONFLICT(owner) DO UPDATE SET last_cursor=c.last_cursor+1
 RETURNING last_cursor INTO next_cursor;
 INSERT INTO orchestrator.events(owner,cursor,type,project_id,initiative_id,task_key,job_id,root_job_id,data)
 VALUES(p_owner,next_cursor,p_type,p_project,p_initiative,p_task,p_job,p_root,p_data);
END $$;

CREATE FUNCTION orchestrator.capture_job_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event_type text; event_data jsonb; initiative uuid; task text;
BEGIN
 IF TG_OP='INSERT' THEN
  event_type := 'job.created';
  event_data := jsonb_build_object('status',NEW.status,'task_type',NEW.task,
   'revision',NEW.root_job_id IS NOT NULL AND NEW.root_job_id<>NEW.id);
 ELSIF NEW.status='running' AND NEW.attempt_count>OLD.attempt_count THEN
  event_type := CASE WHEN NEW.attempt_count=1 THEN 'job.claimed' ELSE 'job.retried' END;
  event_data := jsonb_strip_nulls(jsonb_build_object('attempt',NEW.attempt_count,'phase',
   CASE WHEN NEW.phase='claimed' THEN NEW.phase END));
 ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','blocked') THEN
  event_type := 'job.' || NEW.status;
  event_data := jsonb_strip_nulls(jsonb_build_object('attempt',NEW.attempt_count,
   'result_available',coalesce(jsonb_typeof(NEW.result)='object',false),
   'verification_status',CASE WHEN NEW.result->'verification'->>'status' IN ('passed','failed','not_run')
    THEN NEW.result->'verification'->>'status' END));
 ELSIF OLD.status IN ('failed','blocked') AND NEW.status='queued' THEN
  event_type := 'job.requeued';
  event_data := jsonb_build_object('previous_status',OLD.status,'status',NEW.status,'attempt',NEW.attempt_count);
 ELSIF OLD.status='waiting_dependencies' AND NEW.status='queued' THEN
  event_type := 'job.dependencies_resolved';
  event_data := jsonb_build_object('status',NEW.status);
 ELSIF NEW.status='running' AND NEW.phase IS DISTINCT FROM OLD.phase
   AND NEW.phase IN ('claimed','running','verifying','publishing') THEN
  event_type := 'job.phase_changed';
  event_data := jsonb_strip_nulls(jsonb_build_object('attempt',NEW.attempt_count,'phase',NEW.phase,
   'previous_phase',CASE WHEN OLD.phase IN ('claimed','running','verifying','publishing') THEN OLD.phase END));
 ELSE
  RETURN NULL;
 END IF;

 -- Activation writes the link after inserting the job. Deferral lets the
 -- creation event carry that link, including on an older API binary.
 SELECT t.initiative_id,t.task_key INTO initiative,task FROM orchestrator.initiative_tasks t
 WHERE t.root_job_id=NEW.root_job_id AND t.owner=NEW.submitter_id;
 PERFORM orchestrator.append_event(NEW.submitter_id,event_type,NEW.project_id,initiative,task,
  NEW.id,NEW.root_job_id,event_data);
 RETURN NULL;
END $$;

CREATE FUNCTION orchestrator.capture_initiative_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE event_type text; event_data jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  event_type := 'initiative.created';
  event_data := jsonb_build_object('status',NEW.status,'plan_version',NEW.plan_version);
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  event_type := CASE NEW.status
   WHEN 'active' THEN CASE WHEN OLD.status='draft' THEN 'initiative.activated' ELSE 'initiative.resumed' END
   WHEN 'paused' THEN 'initiative.paused'
   WHEN 'completed' THEN 'initiative.completed'
   WHEN 'cancelled' THEN 'initiative.cancelled'
  END;
  event_data := jsonb_build_object('previous_status',OLD.status,'status',NEW.status,'plan_version',NEW.plan_version);
 ELSIF NEW.plan_version IS DISTINCT FROM OLD.plan_version THEN
  event_type := 'initiative.plan_updated';
  event_data := jsonb_build_object('previous_plan_version',OLD.plan_version,'plan_version',NEW.plan_version);
 END IF;

 IF event_type IS NOT NULL THEN
  PERFORM orchestrator.append_event(NEW.owner,event_type,NEW.project_id,NEW.id,NULL,NULL,NULL,event_data);
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION orchestrator.capture_review_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE project uuid; outcome text;
BEGIN
 SELECT project_id INTO project FROM orchestrator.initiatives WHERE id=NEW.initiative_id AND owner=NEW.owner;
 outcome := NEW.content->>'outcome';
 PERFORM orchestrator.append_event(NEW.owner,'initiative.review_recorded',project,NEW.initiative_id,
  NEW.task_key,NEW.job_id,NEW.root_job_id,jsonb_strip_nulls(jsonb_build_object('review_id',NEW.id,
   'outcome',CASE WHEN outcome IN ('ready_for_human_review','revision_needed','blocked','needs_decision') THEN outcome END)));
 RETURN NULL;
END $$;

CREATE FUNCTION orchestrator.capture_publication_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 principal text; initiative uuid; task text; publishing_job uuid; attempt integer;
 pr_number text := NEW.pull_request->>'number';
 same_pr boolean := coalesce(pr_number=OLD.pull_request->>'number',false);
 merged boolean := coalesce(NEW.pull_request->'merged'='true'::jsonb,false);
 closed boolean := coalesce(NEW.pull_request->>'state'='closed',false);
 event_type text; event_data jsonb;
 state_changed boolean := NEW.publication_state IS DISTINCT FROM OLD.publication_state;
 pr_changed boolean := (NEW.pull_request - 'url') IS DISTINCT FROM (OLD.pull_request - 'url');
BEGIN
 SELECT j.submitter_id INTO STRICT principal FROM orchestrator.jobs j WHERE j.id=NEW.job_id;
 SELECT t.initiative_id,t.task_key INTO initiative,task FROM orchestrator.initiative_tasks t
 WHERE t.root_job_id=NEW.job_id AND t.owner=principal;

 -- Old workers use the same API contract. An old API can identify the
 -- publishing lease holder on a publication state transition.
 SELECT j.id,j.attempt_count INTO publishing_job,attempt FROM orchestrator.jobs j
 WHERE j.root_job_id=NEW.job_id AND j.submitter_id=principal AND j.status='running'
  AND (j.id=NEW.publication_job_id OR state_changed);

 IF state_changed AND NEW.publication_state IN ('verified','pushed') THEN
  PERFORM orchestrator.append_event(principal,'publication.' || NEW.publication_state,NEW.project_id,
   initiative,task,coalesce(publishing_job,NEW.job_id),NEW.job_id,
   jsonb_strip_nulls(jsonb_build_object('attempt',attempt,'head_commit',
    CASE WHEN NEW.publication_state='pushed' AND NEW.head_commit ~ '^[a-f0-9]{40,64}$' THEN NEW.head_commit END)),
   attempt IS NOT NULL);
 END IF;

 IF pr_number IS NULL OR pr_number !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN NULL;
 END IF;

 event_data := jsonb_strip_nulls(jsonb_build_object('number',pr_number::bigint,
  'observed_at',NEW.pull_request_observed_at,'draft',
  CASE WHEN jsonb_typeof(NEW.pull_request->'draft')='boolean' THEN NEW.pull_request->'draft' END,
  'state',CASE WHEN NEW.pull_request->>'state' IN ('open','closed') THEN NEW.pull_request->>'state' END,
  'merged',merged,'head_commit',
  CASE WHEN NEW.pull_request->>'head' ~ '^[a-f0-9]{40,64}$' THEN NEW.pull_request->>'head' END));

 IF NOT same_pr THEN
  event_type := 'pull_request.created';
 ELSIF NOT merged AND NOT closed AND (
   pr_changed OR (state_changed AND NEW.publication_state='published' AND publishing_job<>NEW.job_id)
 ) THEN
  event_type := 'pull_request.updated';
 END IF;
 IF event_type IS NOT NULL THEN
  PERFORM orchestrator.append_event(principal,event_type,NEW.project_id,initiative,task,
   coalesce(publishing_job,NEW.job_id),NEW.job_id,event_data ||
   jsonb_strip_nulls(jsonb_build_object('attempt',attempt)),
   event_type='pull_request.updated' AND NOT pr_changed AND attempt IS NOT NULL);
 END IF;

 IF merged AND (NOT same_pr OR OLD.pull_request->'merged' IS DISTINCT FROM 'true'::jsonb) THEN
  event_type := 'pull_request.merged_observed';
 ELSIF closed AND NOT merged AND (NOT same_pr OR OLD.pull_request->>'state' IS DISTINCT FROM 'closed') THEN
  event_type := 'pull_request.closed_observed';
 ELSE
  RETURN NULL;
 END IF;
 PERFORM orchestrator.append_event(principal,event_type,NEW.project_id,initiative,task,NEW.job_id,NEW.job_id,event_data);
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION
 orchestrator.append_event(text,text,uuid,uuid,text,uuid,uuid,jsonb,boolean),
 orchestrator.capture_job_event(),orchestrator.capture_initiative_event(),
 orchestrator.capture_review_event(),orchestrator.capture_publication_events()
 FROM PUBLIC,conduit_api;

CREATE CONSTRAINT TRIGGER event_job_created AFTER INSERT ON orchestrator.jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestrator.capture_job_event();
CREATE CONSTRAINT TRIGGER event_job_transition AFTER UPDATE ON orchestrator.jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.attempt_count IS DISTINCT FROM NEW.attempt_count OR OLD.phase IS DISTINCT FROM NEW.phase)
 EXECUTE FUNCTION orchestrator.capture_job_event();
CREATE CONSTRAINT TRIGGER event_initiative_created AFTER INSERT ON orchestrator.initiatives
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestrator.capture_initiative_event();
CREATE CONSTRAINT TRIGGER event_initiative_transition AFTER UPDATE ON orchestrator.initiatives
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.plan_version IS DISTINCT FROM NEW.plan_version)
 EXECUTE FUNCTION orchestrator.capture_initiative_event();
CREATE CONSTRAINT TRIGGER event_review_recorded AFTER INSERT ON orchestrator.initiative_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestrator.capture_review_event();
CREATE CONSTRAINT TRIGGER event_publication_transition AFTER UPDATE ON orchestrator.development_tasks
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (OLD.publication_state IS DISTINCT FROM NEW.publication_state OR OLD.pull_request IS DISTINCT FROM NEW.pull_request)
 EXECUTE FUNCTION orchestrator.capture_publication_events();
