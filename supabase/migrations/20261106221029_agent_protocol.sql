-- Additive preparation context; no changes to claims, leases, scopes or publication.
-- NULL policy_version identifies legacy/unversioned acknowledgements.
ALTER TABLE orchestrator.jobs
 ADD COLUMN development_mode text NOT NULL DEFAULT 'normal'
   CHECK (development_mode IN ('normal','detailed')),
 ADD COLUMN original_request text CHECK (length(original_request) BETWEEN 1 AND 12000),
 ADD COLUMN policy_version text CHECK (length(policy_version) BETWEEN 1 AND 100),
 ADD COLUMN accepted_policy_version text CHECK (length(accepted_policy_version) BETWEEN 1 AND 100),
 ADD COLUMN research jsonb CHECK (research IS NULL OR
   (jsonb_typeof(research)='object' AND octet_length(research::text)<=65536));
-- Application validation bounds research to 49152 compact JSON bytes; JSONB text
-- includes formatting overhead. Existing table grants and private-schema RLS apply.
