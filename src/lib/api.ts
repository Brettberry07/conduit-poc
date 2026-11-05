import { authenticate, requiredScope } from "./keys";
import { z } from "zod";
import type { DB } from "./db";
import { claim, report, publicColumns } from "./queue";
const uuid = z.string().uuid();
const createJob = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    task: z
      .enum(["simulate-development", "simulate-failure"])
      .default("simulate-development"),
  })
  .strict();
const reportBody = z
  .object({
    claim_token: uuid,
    action: z.enum(["progress", "completed", "failed"]),
    progress: z.number().int().min(0).max(100).default(0),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.action === "failed" && !v.error)
      c.addIssue({ code: "custom", message: "Failure requires error" });
    if (v.action === "completed" && !v.result)
      c.addIssue({ code: "custom", message: "Completion requires result" });
  });
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("invalid-body");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid-body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new Error("invalid-body");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("invalid-body");
  }
}
export async function handle(req: Request, db: DB): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    const key = await authenticate(db, authorization);
    if (!key) return json({ error: "Unauthorized" }, 401);
    const path = new URL(req.url).pathname;
    const method = req.method;
    const scope = requiredScope(path, method);
    if (!scope) return json({ error: "Not found" }, 404);
    if (!key.scopes.includes(scope)) return json({ error: "Forbidden" }, 403);
    if (method === "POST" && path === "/api/jobs") {
      const input = createJob.parse(await body(req));
      const requestId = uuid.parse(req.headers.get("idempotency-key"));
      const {
        rows: [job],
      } = await db.query(
        `INSERT INTO orchestrator.jobs(title,description,task,submitter_id,request_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(submitter_id,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${publicColumns}`,
        [input.title, input.description, input.task, key.principal, requestId],
      );
      if (
        job.title !== input.title ||
        job.description !== input.description ||
        job.task !== input.task
      )
        return json(
          { error: "Idempotency key already used with different content" },
          409,
        );
      return json({ job }, 201);
    }
    if (method === "GET" && path === "/api/jobs") {
      const url = new URL(req.url);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(url.searchParams.get("limit") ?? 100);
      const before = url.searchParams.get("before");
      if (before) z.string().datetime({ offset: true }).parse(before);
      const { rows } = await db.query(
        `SELECT ${publicColumns} FROM orchestrator.jobs WHERE submitter_id=$1
      AND ($2::timestamptz IS NULL OR created_at<$2) ORDER BY created_at DESC,id DESC LIMIT $3`,
        [key.principal, before, limit],
      );
      return json({ jobs: rows });
    }
    if (method === "GET" && path === "/api/workers") {
      const { rows } = await db.query(`SELECT worker_id,last_seen_at,
      last_seen_at>clock_timestamp()-interval '15 seconds' AS available,
      EXISTS(SELECT 1 FROM orchestrator.jobs j WHERE j.worker_id=w.worker_id AND status='running'
        AND lease_expires_at>clock_timestamp()) AS busy FROM orchestrator.workers w ORDER BY worker_id`);
      return json({ workers: rows });
    }
    if (
      method === "POST" &&
      (path === "/api/heartbeat" || path === "/api/claim")
    ) {
      await db.query(
        `INSERT INTO orchestrator.workers(worker_id) VALUES($1) ON CONFLICT(worker_id)
      DO UPDATE SET last_seen_at=clock_timestamp()`,
        [key.principal],
      );
      return json(
        path === "/api/claim"
          ? { job: await claim(db, key.principal) }
          : { ok: true },
      );
    }
    const match = path.match(/^\/api\/jobs\/([^/]+)(\/report)?$/);
    if (match) {
      const id = uuid.parse(match[1]);
      if (method === "GET" && !match[2]) {
        const {
          rows: [job],
        } = await db.query(
          `SELECT ${publicColumns} FROM orchestrator.jobs WHERE id=$1 AND submitter_id=$2`,
          [id, key.principal],
        );
        return job ? json({ job }) : json({ error: "Not found" }, 404);
      }
      if (method === "POST" && match[2]) {
        const input = reportBody.parse(await body(req));
        const job = await report(
          db,
          id,
          key.principal,
          input.claim_token,
          input.action,
          input.progress,
          input.result,
          input.error ?? null,
        );
        return job
          ? json({ job })
          : json({ error: "Lease lost or claim invalid" }, 409);
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (
      e instanceof z.ZodError ||
      (e instanceof Error && e.message === "invalid-body")
    )
      return json({ error: "Invalid request" }, 400);
    console.error(
      JSON.stringify({
        event: "api_error",
        code: (e as { code?: string }).code ?? "internal",
      }),
    );
    return json({ error: "Internal server error" }, 500);
  }
}
