import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./db";
export const SCOPES = [
  "jobs:revise",
  "jobs:create",
  "jobs:read",
  "jobs:claim",
  "jobs:update",
] as const;
export type Scope = (typeof SCOPES)[number];
export const credentialScopes = {
  instinct: ["jobs:create", "jobs:read", "jobs:revise"],
  worker: ["jobs:claim", "jobs:update"],
  viewer: ["jobs:read"],
} as const;
export const hashKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");
export function generateKey() {
  const token = `cnd_live_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashKey(token), prefix: token.slice(0, 17) };
}
export type Identity = {
  principal: string;
  scopes: Scope[];
  role: "submitter" | "worker";
  id: string;
};
export async function authenticate(
  db: DB,
  authorization: string,
): Promise<Identity | null> {
  if (!/^Bearer cnd_live_[A-Za-z0-9_-]{43}$/.test(authorization)) return null;
  const {
    rows: [key],
  } = await db.query("SELECT * FROM orchestrator.authenticate_api_key($1)", [
    hashKey(authorization.slice(7)),
  ]);
  return key ?? null;
}
export function requiredScope(path: string, method: string): Scope | null {
  if (
    /^\/api\/initiatives(?:\/[^/]+(?:\/(?:plan|activate|resume|reviews))?)?$/.test(
      path,
    )
  ) {
    if (method === "GET" && !path.endsWith("/activate")) return "jobs:read";
    if (
      method === "POST" &&
      (path === "/api/initiatives" || path.endsWith("/activate"))
    )
      return "jobs:create";
    if (
      (method === "PATCH" && !/\/(?:activate|resume|reviews)$/.test(path)) ||
      (method === "POST" && path.endsWith("/reviews"))
    )
      return "jobs:revise";
    return null;
  }
  if (
    method === "GET" &&
    (path === "/api/agent/manifest" ||
      /^\/api\/projects(?:\/[^/]+)?$/.test(path) ||
      /^\/api\/jobs\/[^/]+\/(revisions|executions|changes|diff|publication)$/.test(
        path,
      ))
  )
    return "jobs:read";
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/revisions$/.test(path))
    return "jobs:revise";
  if (
    method === "POST" &&
    (/^\/api\/jobs\/[^/]+\/(publication|artifacts)$/.test(path) ||
      ["/api/development/pending", "/api/development/reconcile"].includes(path))
  )
    return "jobs:update";
  if (method === "POST" && path === "/api/jobs") return "jobs:create";
  if (
    method === "GET" &&
    (path === "/api/jobs" ||
      path === "/api/workers" ||
      /^\/api\/jobs\/[^/]+$/.test(path))
  )
    return "jobs:read";
  if (method === "POST" && path === "/api/claim") return "jobs:claim";
  if (
    method === "POST" &&
    (path === "/api/heartbeat" || /^\/api\/jobs\/[^/]+\/report$/.test(path))
  )
    return "jobs:update";
  return null;
}
