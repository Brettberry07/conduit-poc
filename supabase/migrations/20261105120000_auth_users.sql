-- Only the administrator can link Auth accounts to workspace principals.
CREATE TABLE orchestrator.auth_users (
  auth_user_id uuid PRIMARY KEY,
  principal text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE orchestrator.auth_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON orchestrator.auth_users FROM PUBLIC;
GRANT SELECT ON orchestrator.auth_users TO conduit_api;
CREATE POLICY runtime_auth_users ON orchestrator.auth_users FOR SELECT TO conduit_api USING(true);
-- Reuse the separately provisioned administrator login, never the runtime login.
GRANT SELECT,INSERT,DELETE ON orchestrator.auth_users TO conduit_key_admin;
CREATE POLICY administrator_auth_users ON orchestrator.auth_users
  TO conduit_key_admin USING(true) WITH CHECK(true);
