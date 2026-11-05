-- Upgrade in place: keep job IDs, principals, leases and queue rows unchanged.
ALTER TABLE orchestrator.api_keys
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN name text,
  ADD COLUMN key_prefix text,
  ADD COLUMN scopes text[],
  ADD COLUMN last_used_at timestamptz;
-- Legacy unprefixed keys are deliberately revoked during the credential cutover.
UPDATE orchestrator.api_keys SET name=principal || ' (legacy)',key_prefix='legacy',
  scopes=CASE WHEN role='worker' THEN ARRAY['jobs:claim','jobs:update'] ELSE ARRAY['jobs:create','jobs:read'] END,
  revoked_at=coalesce(revoked_at,clock_timestamp());
ALTER TABLE orchestrator.api_keys
  DROP CONSTRAINT api_keys_pkey,
  ADD PRIMARY KEY(id),
  ADD UNIQUE(key_hash),
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN key_prefix SET NOT NULL,
  ALTER COLUMN scopes SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp()+interval '30 days'),
  ADD CHECK(length(name) BETWEEN 1 AND 120),
  ADD CHECK(key_prefix='legacy' OR key_prefix ~ '^cnd_live_[A-Za-z0-9_-]{8}$'),
  ADD CHECK(cardinality(scopes)>0 AND array_position(scopes,NULL) IS NULL
    AND scopes <@ ARRAY['jobs:create','jobs:read','jobs:claim','jobs:update']::text[]),
  ADD CHECK((role='submitter' AND scopes <@ ARRAY['jobs:create','jobs:read']::text[])
    OR (role='worker' AND scopes <@ ARRAY['jobs:claim','jobs:update']::text[]));
COMMENT ON TABLE orchestrator.api_keys IS 'Conduit credentials: SHA-256 hashes only. Plaintext is delivered once by the administrator CLI.';
