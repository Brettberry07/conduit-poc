import type { DB } from "./db";
import { authenticate } from "./keys";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
// Public readiness check: verify connectivity and queue-schema access without exposing data.
export async function health(getDatabase: () => DB): Promise<Response> {
  try {
    await getDatabase().query("SELECT 1 FROM orchestrator.jobs LIMIT 0");
    return json({ status: "ok", service: "Conduit POC", database: "ok" });
  } catch {
    return json(
      {
        status: "unavailable",
        service: "Conduit POC",
        database: "unavailable",
      },
      503,
    );
  }
}
// A valid worker key authenticates, but cannot pass the Instinct permission check.
export async function authCheck(
  request: Request,
  getDatabase: () => DB,
): Promise<Response> {
  try {
    const key = await authenticate(
      getDatabase(),
      request.headers.get("authorization") ?? "",
    );
    if (!key)
      return json(
        { authenticated: false, instinct_access: false, error: "Unauthorized" },
        401,
      );
    const permissions = {
      create_jobs: key.scopes.includes("jobs:create"),
      read_jobs: key.scopes.includes("jobs:read"),
    };
    const access = permissions.create_jobs && permissions.read_jobs;
    return json(
      {
        authenticated: true,
        instinct_access: access,
        principal: key.principal,
        scopes: key.scopes,
        permissions,
        ...(!access ? { error: "Insufficient permissions" } : {}),
      },
      access ? 200 : 403,
    );
  } catch {
    return json({ error: "Service unavailable" }, 503);
  }
}
