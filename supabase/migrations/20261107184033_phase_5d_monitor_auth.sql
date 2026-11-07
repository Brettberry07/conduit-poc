-- Monitor requests validate the same credentials without updating last_used_at.
-- The runtime role still cannot select key hashes or administer keys.
CREATE FUNCTION orchestrator.inspect_api_key(p_key_hash text)
RETURNS TABLE(principal text,scopes text[],role text,id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$
  SELECT k.principal,k.scopes,k.role,k.id
  FROM orchestrator.api_keys AS k
  WHERE k.key_hash=p_key_hash AND k.key_prefix<>'legacy'
    AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp();
$$;
REVOKE ALL ON FUNCTION orchestrator.inspect_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orchestrator.inspect_api_key(text) TO conduit_api;
