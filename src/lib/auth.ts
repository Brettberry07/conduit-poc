import { createPublicKey, verify, type webcrypto } from "node:crypto";
import type { DB } from "./db";
import { authenticate, type Identity } from "./keys";

type Jwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string };
export function jwtVerifier(
  fetcher: typeof fetch = (...args) => fetch(...args),
) {
  const pending = new Map<string, Promise<{ keys: Jwk[]; expires: number }>>();
  const cache = new Map<string, { keys: Jwk[]; expires: number }>();
  return async (token: string, base: string): Promise<string | null> => {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
        return null;
      const [headerB64, payloadB64, signatureB64] = parts;
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString(),
      );
      if (header.alg !== "ES256" || typeof header.kid !== "string") return null;
      const issuer = base.replace(/\/$/, "") + "/auth/v1";
      const now = Date.now();
      let entry = cache.get(issuer);
      let loading = pending.get(issuer);
      if (!loading && (!entry || entry.expires <= now)) {
        loading = (async () => {
          // Cache misses and failures for the window too.
          const fresh = { keys: [] as Jwk[], expires: now + 300000 };
          cache.set(issuer, fresh);
          try {
            const response = await fetcher(issuer + "/.well-known/jwks.json", {
              signal: AbortSignal.timeout(5000),
              redirect: "error",
            });
            if (!response.ok || !response.body) return fresh;
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 65536) {
                  await reader.cancel();
                  return fresh;
                }
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (Array.isArray(body.keys)) fresh.keys = body.keys;
          } catch {
            // Retrieval failures remain fail-closed for the cache window.
          }
          return fresh;
        })().finally(() => pending.delete(issuer));
        pending.set(issuer, loading);
      }
      if (loading) entry = await loading;
      if (!entry) return null;
      const jwk = entry.keys.find(
        (k) =>
          k.kid === header.kid &&
          k.kty === "EC" &&
          k.crv === "P-256" &&
          (!k.alg || k.alg === "ES256") &&
          (!k.use || k.use === "sig"),
      );
      if (
        !jwk ||
        !verify(
          "sha256",
          Buffer.from(headerB64 + "." + payloadB64),
          {
            key: createPublicKey({ key: jwk, format: "jwk" }),
            dsaEncoding: "ieee-p1363",
          },
          Buffer.from(signatureB64, "base64url"),
        )
      )
        return null;
      // No expiration grace: expired credentials are rejected.
      if (
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp <= now / 1000 ||
        (payload.nbf !== undefined &&
          (typeof payload.nbf !== "number" ||
            !Number.isFinite(payload.nbf) ||
            payload.nbf > now / 1000)) ||
        payload.iss !== issuer ||
        payload.aud !== "authenticated" ||
        typeof payload.sub !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          payload.sub,
        )
      )
        return null;
      return payload.sub;
    } catch {
      return null;
    }
  };
}
const verifyJwt = jwtVerifier();
export async function authenticateConsole(
  db: DB,
  authorization: string,
  base = process.env.NEXT_PUBLIC_SUPABASE_URL,
  verifier = verifyJwt,
  keyOptions?: Parameters<typeof authenticate>[2],
): Promise<Identity | null | "unlinked"> {
  if (/^Bearer cnd_live_[A-Za-z0-9_-]{43}$/.test(authorization))
    return authenticate(db, authorization, keyOptions);
  if (!base || !authorization.startsWith("Bearer ")) return null;
  const sub = await verifier(authorization.slice(7), base);
  if (!sub) return null;
  const {
    rows: [mapping],
  } = await db.query(
    "SELECT principal FROM orchestrator.auth_users WHERE auth_user_id=$1",
    [sub],
  );
  return mapping
    ? {
        principal: mapping.principal,
        scopes: ["jobs:read"],
        role: "submitter",
        id: sub,
      }
    : "unlinked";
}
