import { eventApi } from "./event-api";
import { monitorSnapshot } from "./monitor-api";
import { initiativeApi } from "./initiative-api";
import { developmentApi } from "./development-api";
import { agentManifest } from "./agent-protocol";
import { DEVELOPMENT_BODY_LIMIT } from "./research";
import { DevelopmentError } from "./development";
import { requiredScope } from "./keys";
import { authenticateConsole } from "./auth";
import { z } from "zod";
import type { DB } from "./db";
import {
  claim,
  report,
  retryJob,
  publicColumns,
  workerAvailableSql,
  MAX_ATTEMPTS,
} from "./queue";
const uuid = z.string().uuid();
const retryBody = z
  .object({ expected_attempt_count: z.number().int().min(0).max(MAX_ATTEMPTS) })
  .strict();
const createJob = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    task: z
      .enum(["simulate-development", "simulate-failure", "codex_task"])
      .default("simulate-development"),
    instructions: z.string().trim().min(1).max(12000).optional(),
    acceptance_criteria: z.string().max(4000).optional(),
    project: z.literal("typescript-sandbox").optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.task === "codex_task" &&
      (!v.instructions || v.project !== "typescript-sandbox")
    )
      c.addIssue({
        code: "custom",
        message: "Codex requires instructions and allowed project",
      });
    if (
      v.task !== "codex_task" &&
      (v.instructions !== undefined ||
        v.acceptance_criteria !== undefined ||
        v.project !== undefined)
    )
      c.addIssue({
        code: "custom",
        message: "Development fields require codex_task",
      });
  });
const reportBody = z
  .object({
    claim_token: uuid,
    action: z.enum(["progress", "completed", "failed", "blocked"]),
    progress: z.number().int().min(0).max(100).default(0),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (["failed", "blocked"].includes(v.action) && !v.error)
      c.addIssue({ code: "custom", message: "Failure requires error" });
    if (v.action === "completed" && !v.result)
      c.addIssue({ code: "custom", message: "Completion requires result" });
  });
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(req: Request, max = 32768) {
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
    if (size > max) {
      await reader.cancel();
      throw new Error("invalid-body");
    }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (
      new URL(req.url).pathname === "/api/jobs" &&
      parsed?.task !== "development" &&
      size > 32768
    )
      throw new Error("invalid-body");
    return parsed;
  } catch {
    throw new Error("invalid-body");
  }
}
export async function handle(req: Request, db: DB): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const monitor = method === "GET" && path === "/api/agent/monitor";
    const key = await authenticateConsole(
      db,
      authorization,
      undefined,
      undefined,
      {
        recordUsage: !monitor,
      },
    );
    if (key === "unlinked") return json({ error: "account not linked" }, 403);
    if (!key) return json({ error: "Unauthorized" }, 401);
    const scope = requiredScope(path, method);
    if (!scope) return json({ error: "Not found" }, 404);
    if (!key.scopes.includes(scope)) return json({ error: "Forbidden" }, 403);
    if (monitor) {
      if (key.role !== "submitter") return json({ error: "Forbidden" }, 403);
      return json(await monitorSnapshot(db, key.principal, url.searchParams));
    }
    if (method === "GET" && path === "/api/agent/manifest")
      return json(agentManifest());
    const events = await eventApi(req, db, key, body);
    if (events) return events;
    const initiative = await initiativeApi(req, db, key, body);
    if (initiative) return initiative;
    const creationBody =
      method === "POST" && path === "/api/jobs"
        ? await body(req, DEVELOPMENT_BODY_LIMIT)
        : undefined;
    const development = await developmentApi(req, db, key, body, creationBody);
    if (development) return development;
    if (method === "POST" && path === "/api/jobs") {
      const input = createJob.parse(creationBody);
      const requestId = uuid.parse(req.headers.get("idempotency-key"));
      const {
        rows: [job],
      } = await db.query(
        `INSERT INTO orchestrator.jobs(title,description,task,submitter_id,request_id,instructions,acceptance_criteria,project)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(submitter_id,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${publicColumns}`,
        [
          input.title,
          input.description,
          input.task,
          key.principal,
          requestId,
          input.instructions ?? null,
          input.acceptance_criteria ?? null,
          input.project ?? null,
        ],
      );
      if (
        job.title !== input.title ||
        job.description !== input.description ||
        job.task !== input.task ||
        job.instructions !== (input.instructions ?? null) ||
        job.acceptance_criteria !== (input.acceptance_criteria ?? null) ||
        job.project !== (input.project ?? null)
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
      ${workerAvailableSql} AS available,
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
    const match = path.match(/^\/api\/jobs\/([^/]+)(?:\/(report|retry))?$/);
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
      if (method === "POST" && match[2] === "retry") {
        if (key.role !== "submitter") return json({ error: "Forbidden" }, 403);
        const input = retryBody.parse(await body(req));
        const job = await retryJob(
          db,
          id,
          key.principal,
          input.expected_attempt_count,
        );
        return json({ job });
      }
      if (method === "POST" && match[2] === "report") {
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
    if (e instanceof DevelopmentError)
      return json({ error: e.message }, e.status);
    if (
      e instanceof z.ZodError &&
      new URL(req.url).pathname.startsWith("/api/initiatives") &&
      e.issues.some(
        (issue) =>
          issue.message === "Detailed mode requires a cited research brief",
      )
    )
      return json(
        {
          error:
            "Detailed tasks require their own valid Phase 5A cited research brief; initiative research is not inherited",
        },
        400,
      );
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
