-- REVIEW ONLY. Not in migrations/: never applied by normal migration runner.
-- Requires separate approval, a disposable Supabase verification, and current grants audit.
-- No identity, subscriber or authorized caller provisioned by this file.
CREATE TABLE orchestrator.wake_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 generation bigint NOT NULL DEFAULT 0, delivered bigint NOT NULL DEFAULT 0,
 next_attempt timestamptz NOT NULL DEFAULT '-infinity', failures integer NOT NULL DEFAULT 0
);
INSERT INTO orchestrator.wake_control DEFAULT VALUES;
ALTER TABLE orchestrator.wake_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orchestrator.wake_control FROM PUBLIC,anon,authenticated,conduit_api;
CREATE TABLE orchestrator.wake_subscribers(subject uuid PRIMARY KEY, topic text NOT NULL CHECK(topic='conduit:pool:shared'));
CREATE TABLE orchestrator.wake_callers(principal text PRIMARY KEY,last_requested timestamptz NOT NULL DEFAULT '-infinity');
CREATE TABLE orchestrator.wake_requests(principal text NOT NULL,request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(principal,request_id));
ALTER TABLE orchestrator.wake_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.wake_callers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.wake_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orchestrator.wake_subscribers,orchestrator.wake_callers,orchestrator.wake_requests FROM PUBLIC,anon,authenticated,conduit_api;
CREATE FUNCTION orchestrator.can_receive_worker_wake() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM orchestrator.wake_subscribers WHERE subject=auth.uid() AND topic=realtime.topic());
$$;
REVOKE ALL ON FUNCTION orchestrator.can_receive_worker_wake() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator.can_receive_worker_wake() TO authenticated;
-- Exact fixed shared dispatch pool, not an invented owner-to-worker partition.
CREATE POLICY conduit_worker_receive ON realtime.messages FOR SELECT TO authenticated
 USING(extension='broadcast' AND orchestrator.can_receive_worker_wake());
GRANT USAGE ON SCHEMA orchestrator TO authenticated;
-- USAGE alone is not data access. No table grants, no Data API exposure or console mapping.
CREATE FUNCTION orchestrator.signal_worker_wake() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE orchestrator.wake_control SET generation=generation+1 WHERE singleton AND enabled;
$$;
REVOKE ALL ON FUNCTION orchestrator.signal_worker_wake() FROM PUBLIC;
CREATE FUNCTION orchestrator.queue_worker_wake() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='jobs' THEN
  IF NEW.status='queued' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN PERFORM orchestrator.signal_worker_wake(); END IF;
 ELSIF TG_TABLE_NAME='initiatives' THEN
  IF NEW.status='active' AND OLD.status IS DISTINCT FROM NEW.status THEN PERFORM orchestrator.signal_worker_wake(); END IF;
 ELSIF TG_TABLE_NAME='development_tasks' THEN
  IF coalesce((NEW.pull_request->>'merged')::boolean,false) AND NOT coalesce((OLD.pull_request->>'merged')::boolean,false) THEN PERFORM orchestrator.signal_worker_wake(); END IF;
 ELSIF TG_TABLE_NAME='projects' THEN
  IF NEW.enabled AND NOT OLD.enabled THEN PERFORM orchestrator.signal_worker_wake(); END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orchestrator.queue_worker_wake() FROM PUBLIC;
CREATE TRIGGER wake_jobs AFTER INSERT OR UPDATE OF status ON orchestrator.jobs FOR EACH ROW EXECUTE FUNCTION orchestrator.queue_worker_wake();
CREATE TRIGGER wake_initiatives AFTER UPDATE OF status ON orchestrator.initiatives FOR EACH ROW EXECUTE FUNCTION orchestrator.queue_worker_wake();
CREATE TRIGGER wake_merges AFTER UPDATE OF pull_request ON orchestrator.development_tasks FOR EACH ROW EXECUTE FUNCTION orchestrator.queue_worker_wake();
CREATE TRIGGER wake_projects AFTER UPDATE OF enabled ON orchestrator.projects FOR EACH ROW EXECUTE FUNCTION orchestrator.queue_worker_wake();
CREATE FUNCTION orchestrator.request_worker_wake(p_principal text,p_request uuid) RETURNS TABLE(accepted boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t timestamptz;
BEGIN
 SELECT last_requested INTO t FROM orchestrator.wake_callers WHERE principal=p_principal FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT false; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM orchestrator.wake_requests WHERE principal=p_principal AND request_id=p_request) THEN RETURN QUERY SELECT true; RETURN; END IF;
 IF t>clock_timestamp()-interval '60 seconds' THEN RETURN QUERY SELECT false; RETURN; END IF;
 INSERT INTO orchestrator.wake_requests(principal,request_id) VALUES(p_principal,p_request);
 UPDATE orchestrator.wake_callers SET last_requested=clock_timestamp() WHERE principal=p_principal;
 PERFORM orchestrator.signal_worker_wake();
 RETURN QUERY SELECT true;
END $$;
REVOKE ALL ON FUNCTION orchestrator.request_worker_wake(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator.request_worker_wake(text,uuid) TO conduit_api;
CREATE FUNCTION orchestrator.flush_worker_wake() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r orchestrator.wake_control; message_id uuid;
BEGIN
 SELECT * INTO r FROM orchestrator.wake_control WHERE singleton AND enabled FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR r.generation=r.delivered OR r.next_attempt>clock_timestamp() THEN RETURN; END IF;
 BEGIN
  message_id := gen_random_uuid();
  PERFORM realtime.send(jsonb_build_object('v',1,'id',message_id),'work_available','conduit:pool:shared',true);
  -- Hosted realtime.send catches internal errors as warnings. Check durable insertion.
  IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE payload->>'id'=message_id::text AND topic='conduit:pool:shared' AND event='work_available' AND private AND extension='broadcast') THEN
    RAISE EXCEPTION 'Wake message not inserted';
  END IF;
  UPDATE orchestrator.wake_control SET delivered=r.generation,failures=0,next_attempt='-infinity' WHERE singleton;
 EXCEPTION WHEN OTHERS THEN
  UPDATE orchestrator.wake_control SET failures=least(failures+1,10),next_attempt=clock_timestamp()+interval '5 minutes' WHERE singleton;
 END;
END $$;
REVOKE ALL ON FUNCTION orchestrator.flush_worker_wake() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator.flush_worker_wake() TO conduit_api;
-- Narrowly replace only the audited scope constraint, preserving all existing key scopes.
ALTER TABLE orchestrator.api_keys DROP CONSTRAINT api_keys_check;
ALTER TABLE orchestrator.api_keys ADD CONSTRAINT api_keys_check CHECK(cardinality(scopes)>0 AND array_position(scopes,NULL) IS NULL AND
 ((role='submitter' AND scopes <@ ARRAY['jobs:create','jobs:read','jobs:revise','jobs:wake']::text[]) OR
 (role='worker' AND scopes <@ ARRAY['jobs:claim','jobs:update']::text[])));
