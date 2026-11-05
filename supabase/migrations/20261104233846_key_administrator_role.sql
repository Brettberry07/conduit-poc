-- A separate administrator credential can manage API keys without owning the
-- database, reading jobs, or granting itself additional runtime privileges.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='conduit_key_admin') THEN
  CREATE ROLE conduit_key_admin NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA orchestrator TO conduit_key_admin;
GRANT SELECT,INSERT,UPDATE ON orchestrator.api_keys TO conduit_key_admin;
CREATE POLICY key_administrator ON orchestrator.api_keys TO conduit_key_admin USING(true) WITH CHECK(true);
