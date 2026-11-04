-- Private schema: no Data API access or browser credentials.
CREATE SCHEMA orchestrator;
REVOKE ALL ON SCHEMA orchestrator FROM PUBLIC;
CREATE TABLE orchestrator.api_keys (
  key_hash text PRIMARY KEY CHECK(length(key_hash)=64),
  principal text NOT NULL CHECK(length(principal) BETWEEN 1 AND 80),
  role text NOT NULL CHECK(role IN ('submitter','worker')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE orchestrator.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  task text NOT NULL CHECK(task IN ('simulate-development','simulate-failure')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  submitter_id text NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  completed_at timestamptz,
  worker_id text,
  claim_token uuid,
  result jsonb,
  error text,
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  lease_expires_at timestamptz,
  UNIQUE(submitter_id,request_id),
  CHECK((status='running')=(lease_expires_at IS NOT NULL)),
  CHECK((status IN ('completed','failed'))=(completed_at IS NOT NULL))
);
CREATE INDEX jobs_claim_idx ON orchestrator.jobs(created_at,id) WHERE status IN ('queued','running');
CREATE INDEX jobs_owner_idx ON orchestrator.jobs(submitter_id,created_at DESC);
CREATE TABLE orchestrator.workers (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE orchestrator.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestrator.workers ENABLE ROW LEVEL SECURITY;
-- No public policies or grants. Only the trusted Next.js DB connection accesses these tables.
REVOKE ALL ON ALL TABLES IN SCHEMA orchestrator FROM PUBLIC;
