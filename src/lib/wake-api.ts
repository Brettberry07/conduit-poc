import { z } from "zod";
import type { DB } from "./db";
import type { Identity } from "./keys";
export const wakeEnabled = () => process.env.CONDUIT_WAKE_ENABLED === "true";
export async function wakeApi(
  req: Request,
  db: DB,
  key: Identity,
  readBody: (r: Request, max?: number) => Promise<any>,
) {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/api/worker-wake")
    return null;
  if (!wakeEnabled())
    return Response.json({ error: "Not found" }, { status: 404 });
  if (key.role !== "submitter" || !key.scopes.includes("jobs:wake"))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const id = z.string().uuid().parse(req.headers.get("idempotency-key"));
  z.object({})
    .strict()
    .parse(await readBody(req, 128));
  const {
    rows: [r],
  } = await db.query("SELECT * FROM orchestrator.request_worker_wake($1,$2)", [
    key.principal,
    id,
  ]);
  return Response.json(
    { accepted: r?.accepted === true, delivered: false },
    {
      status: r?.accepted ? 202 : 429,
      headers: {
        "Cache-Control": "no-store",
        ...(r?.accepted ? {} : { "Retry-After": "60" }),
      },
    },
  );
}
// Runs after the request transaction committed. Failure cannot undo accepted work.
// The database helper serializes the fixed-pool outbox and has no arbitrary-topic input.
export async function flushWake(db: DB) {
  if (!wakeEnabled()) return;
  try {
    await db.query("SELECT orchestrator.flush_worker_wake()");
  } catch {
    console.error(JSON.stringify({ event: "wake_delivery_pending" }));
  }
}

export function mayProduceWake(req: Request): boolean {
  const p = new URL(req.url).pathname;
  if (req.method === "POST")
    return (
      [
        "/api/jobs",
        "/api/claim",
        "/api/development/reconcile",
        "/api/worker-wake",
      ].includes(p) ||
      /^\/api\/jobs\/[^/]+\/(revisions|retry)$/.test(p) ||
      /^\/api\/initiatives\/[^/]+\/activate$/.test(p)
    );
  return req.method === "PATCH" && /^\/api\/initiatives\/[^/]+$/.test(p);
}
