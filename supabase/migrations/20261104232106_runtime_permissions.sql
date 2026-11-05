-- A NOLOGIN group, assumed only by the separately provisioned server login.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='conduit_api') THEN
    CREATE ROLE conduit_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA orchestrator TO conduit_api;
GRANT SELECT,INSERT,UPDATE ON orchestrator.jobs,orchestrator.workers TO conduit_api;
CREATE POLICY runtime_jobs ON orchestrator.jobs TO conduit_api USING(true) WITH CHECK(true);
CREATE POLICY runtime_workers ON orchestrator.workers TO conduit_api USING(true) WITH CHECK(true);
-- Authorization/ownership is enforced by the trusted HTTP API. Ordinary Supabase
-- anon/authenticated roles get no schema, table, or function permissions.
-- Runtime cannot read key hashes, create keys, change scopes, or revoke keys.
REVOKE ALL ON orchestrator.api_keys FROM conduit_api;
CREATE FUNCTION orchestrator.authenticate_api_key(p_key_hash text)
RETURNS TABLE(principal text,scopes text[],role text,id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$
  UPDATE orchestrator.api_keys AS k SET last_used_at=clock_timestamp()
  WHERE k.key_hash=p_key_hash AND k.key_prefix<>'legacy'
    AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp()
  RETURNING k.principal,k.scopes,k.role,k.id;
$$;
REVOKE ALL ON FUNCTION orchestrator.authenticate_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator.authenticate_api_key(text) TO conduit_api;
COMMENT ON FUNCTION orchestrator.authenticate_api_key(text) IS 'Narrow definer function: runtime may validate a hash and touch last-used, never administer keys. Private schema, empty search_path, explicit execution grant.';
