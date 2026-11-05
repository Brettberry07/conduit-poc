import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import type { Identity } from "./keys";
import { publicColumns } from "./queue";
import {
  approvedProject,
  branchSchema,
  developmentInput,
  DevelopmentError,
  featureBranch,
  projectColumns,
  revisionInput,
} from "./development";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const pr = z
  .object({
    number: z.number().int().positive(),
    url: z
      .string()
      .url()
      .regex(/^https:\/\/github\.com\//),
    draft: z.boolean(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    head: sha.optional(),
    base_branch: branchSchema.optional(),
  })
  .strict();
export async function developmentApi(
  req: Request,
  db: DB,
  key: Identity,
  readBody: (req: Request, max?: number) => Promise<any>,
  creationBody?: unknown,
): Promise<Response | null> {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  if (method === "GET" && /^\/api\/projects(?:\/[^/]+)?$/.test(path)) {
    const id = path.split("/")[3];
    if (id) z.string().uuid().parse(id);
    const { rows } = await db.query(
      `SELECT ${projectColumns} FROM orchestrator.projects WHERE enabled AND ($1::uuid IS NULL OR id=$1) ORDER BY name LIMIT 100`,
      [id ?? null],
    );
    return id
      ? rows[0]
        ? json({ project: rows[0] })
        : json({ error: "Not found" }, 404)
      : json({ projects: rows });
  }
  if (method === "POST" && path === "/api/jobs") {
    const raw = creationBody as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || raw.task !== "development")
      return null;
    const input = developmentInput.parse(raw),
      requestId = z.string().uuid().parse(req.headers.get("idempotency-key"));
    const { branch } = await approvedProject(
      db,
      input.project_id,
      input.base_branch,
    );
    // Immutable edges point only to existing root tasks. A new node cannot introduce a cycle.
    const deps = await db.query(
      `SELECT id FROM orchestrator.jobs WHERE id=ANY($1::uuid[]) AND root_job_id=id AND task='development' AND submitter_id=$2 AND project_id=$3 AND base_branch=$4`,
      [input.dependency_job_ids, key.principal, input.project_id, branch],
    );
    if (deps.rows.length !== input.dependency_job_ids.length)
      throw new DevelopmentError(
        "Invalid dependency; use existing owned root jobs in this project",
        400,
      );
    const id = randomUUID();
    const {
      rows: [job],
    } = await db.query(
      `WITH created AS (INSERT INTO orchestrator.jobs(id,title,description,task,submitter_id,request_id,instructions,acceptance_criteria,project_id,root_job_id,base_branch,dependency_job_ids,status)
   VALUES($1,$2,$3,'development',$4,$5,$6,$7,$8,$1,$9,$10,CASE WHEN cardinality($10::uuid[])>0 THEN 'waiting_dependencies' ELSE 'queued' END)
   ON CONFLICT(submitter_id,request_id) DO UPDATE SET request_id=excluded.request_id RETURNING *),
   registered AS (INSERT INTO orchestrator.development_tasks(job_id,project_id,branch,base_branch)
    SELECT id,project_id,$11,base_branch FROM created WHERE task='development' AND root_job_id=id ON CONFLICT(job_id) DO NOTHING)
   SELECT ${publicColumns} FROM created`,
      [
        id,
        input.title,
        input.description,
        key.principal,
        requestId,
        input.instructions,
        input.acceptance_criteria,
        input.project_id,
        branch,
        input.dependency_job_ids,
        featureBranch(id, input.title),
      ],
    );
    if (
      job.title !== input.title ||
      job.description !== input.description ||
      job.task !== "development" ||
      job.instructions !== input.instructions ||
      job.acceptance_criteria !== input.acceptance_criteria ||
      job.project_id !== input.project_id ||
      job.base_branch !== branch ||
      JSON.stringify(job.dependency_job_ids) !==
        JSON.stringify(input.dependency_job_ids)
    )
      throw new DevelopmentError(
        "Idempotency key already used with different content",
      );

    return json({ job }, 201);
  }
  if (method === "POST" && path === "/api/development/pending") {
    const { rows } = await db.query(
      `SELECT t.*,row_to_json(p) AS project_record FROM orchestrator.development_tasks t JOIN orchestrator.projects p ON p.id=t.project_id WHERE p.enabled AND t.pull_request IS NOT NULL AND coalesce((t.pull_request->>'merged')::boolean,false)=false AND t.pull_request->>'state'='open' ORDER BY t.updated_at LIMIT 100`,
    );
    return json({ tasks: rows });
  }
  if (method === "POST" && path === "/api/development/reconcile") {
    const v = z
      .object({ root_job_id: z.string().uuid(), pull_request: pr })
      .strict()
      .parse(await readBody(req));
    await db.query(
      `UPDATE orchestrator.development_tasks SET pull_request=$2,updated_at=clock_timestamp() WHERE job_id=$1 AND pull_request->>'number'=$3 AND pull_request->>'url'=$4`,
      [
        v.root_job_id,
        v.pull_request,
        String(v.pull_request.number),
        v.pull_request.url,
      ],
    );
    return json({ ok: true });
  }
  const match = path.match(
    /^\/api\/jobs\/([^/]+)\/(revisions|executions|changes|diff|publication|artifacts)$/,
  );
  if (!match) return null;
  const id = z.string().uuid().parse(match[1]),
    op = match[2];
  if (method === "POST" && ["publication", "artifacts"].includes(op)) {
    const raw = await readBody(req, op === "artifacts" ? 524288 : 32768);
    const token = z.string().uuid().parse(raw.claim_token);
    // Lock and mutate in the same statement; no check-then-write lease race.
    if (op === "publication") {
      const v = z
        .object({
          claim_token: z.string().uuid(),
          base_commit: sha.optional(),
          head_commit: sha.optional(),
          starting_commit: sha.optional(),
          pull_request: pr.optional(),
          publication_state: z
            .enum([
              "prepared",
              "executing",
              "verified",
              "committed",
              "pushed",
              "published",
              "blocked",
            ])
            .optional(),
          phase: z
            .enum(["claimed", "running", "verifying", "publishing"])
            .optional(),
        })
        .strict()
        .parse(raw);
      const { rows } = await db.query(
        `WITH owned AS (UPDATE orchestrator.jobs SET phase=coalesce($4,phase) WHERE id=$1 AND task='development' AND worker_id=$2 AND claim_token=$3 AND status='running' AND lease_expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM orchestrator.projects p WHERE p.id=orchestrator.jobs.project_id AND p.enabled AND orchestrator.jobs.base_branch=ANY(p.allowed_base_branches)) RETURNING root_job_id,id,attempt_count),
    attempt AS (UPDATE orchestrator.execution_attempts a SET starting_commit=coalesce(a.starting_commit,$9) FROM owned o WHERE a.job_id=o.id AND a.attempt=o.attempt_count AND a.completed_at IS NULL)
    UPDATE orchestrator.development_tasks t SET base_commit=coalesce(t.base_commit,$5),head_commit=coalesce($6,t.head_commit),pull_request=coalesce($7,t.pull_request),publication_state=coalesce($8,t.publication_state),updated_at=clock_timestamp() FROM owned o WHERE t.job_id=o.root_job_id RETURNING t.*`,
        [
          id,
          key.principal,
          token,
          v.phase ?? null,
          v.base_commit ?? null,
          v.head_commit ?? null,
          v.pull_request ?? null,
          v.publication_state ?? null,
          v.starting_commit ?? null,
        ],
      );
      return rows[0]
        ? json({ publication: rows[0] })
        : json({ error: "Lease lost or claim invalid" }, 409);
    }
    const v = z
      .object({
        claim_token: z.string().uuid(),
        kind: z.enum(["execution", "pull_request"]),
        files: z
          .array(
            z
              .object({
                path: z.string().max(240),
                old_path: z.string().max(240).optional(),
                status: z.enum([
                  "added",
                  "modified",
                  "deleted",
                  "renamed",
                  "copied",
                  "type_changed",
                ]),
                additions: z.number().int().min(0),
                deletions: z.number().int().min(0),
                binary: z.boolean().optional(),
                diff_truncated: z.boolean().optional(),
              })
              .strict(),
          )
          .max(100),
        diff: z.string().max(160000),
      })
      .strict()
      .parse(raw);
    const { rows } = await db.query(
      `WITH owned AS (SELECT id,attempt_count FROM orchestrator.jobs WHERE id=$1 AND task='development' AND worker_id=$2 AND claim_token=$3 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE)
   INSERT INTO orchestrator.change_artifacts(job_id,attempt,kind,files,diff) SELECT id,attempt_count,$4,$5,$6 FROM owned ON CONFLICT(job_id,attempt,kind) DO UPDATE SET files=excluded.files,diff=excluded.diff RETURNING job_id`,
      [id, key.principal, token, v.kind, JSON.stringify(v.files), v.diff],
    );
    return rows.length
      ? json({ ok: true })
      : json({ error: "Lease lost or claim invalid" }, 409);
  }
  const {
    rows: [job],
  } = await db.query(
    `SELECT ${publicColumns} FROM orchestrator.jobs WHERE id=$1 AND submitter_id=$2 AND task='development'`,
    [id, key.principal],
  );
  if (!job) return json({ error: "Not found" }, 404);
  const {
    rows: [task],
  } = await db.query(
    "SELECT * FROM orchestrator.development_tasks WHERE job_id=$1",
    [job.root_job_id],
  );
  if (method === "POST" && op === "revisions") {
    const v = revisionInput.parse(await readBody(req)),
      requestId = z.string().uuid().parse(req.headers.get("idempotency-key"));
    const {
      rows: [existing],
    } = await db.query(
      `SELECT ${publicColumns} FROM orchestrator.jobs WHERE submitter_id=$1 AND request_id=$2`,
      [key.principal, requestId],
    );
    if (existing) {
      if (
        existing.root_job_id !== job.root_job_id ||
        existing.id === job.root_job_id ||
        existing.instructions !== v.instructions ||
        existing.acceptance_criteria !== v.acceptance_criteria
      )
        throw new DevelopmentError(
          "Idempotency key already used with different content",
        );
      return json({ job: existing }, 201);
    }
    await approvedProject(db, job.project_id, job.base_branch);
    if (
      task?.publication_state !== "published" ||
      !task?.head_commit ||
      !task.pull_request ||
      task.pull_request.state !== "open" ||
      task.pull_request.merged ||
      !task.pull_request.draft
    )
      throw new DevelopmentError(
        "Revision requires an open draft pull request",
      );
    const {
      rows: [revision],
    } = await db.query(
      `INSERT INTO orchestrator.jobs(title,task,submitter_id,request_id,instructions,acceptance_criteria,project_id,root_job_id,base_branch)
   VALUES($1,'development',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(submitter_id,request_id) DO UPDATE SET request_id=excluded.request_id RETURNING ${publicColumns}`,
      [
        job.title,
        key.principal,
        requestId,
        v.instructions,
        v.acceptance_criteria,
        job.project_id,
        job.root_job_id,
        job.base_branch,
      ],
    );
    if (
      revision.root_job_id !== job.root_job_id ||
      revision.instructions !== v.instructions ||
      revision.acceptance_criteria !== v.acceptance_criteria
    )
      throw new DevelopmentError(
        "Idempotency key already used with different content",
      );
    return json({ job: revision }, 201);
  }
  if (method !== "GET") return null;
  if (op === "publication") return json({ publication: task ?? null });
  if (op === "revisions") {
    const { rows } = await db.query(
      `SELECT ${publicColumns} FROM orchestrator.jobs WHERE root_job_id=$1 ORDER BY created_at,id LIMIT 100`,
      [job.root_job_id],
    );
    return json({ jobs: rows });
  }
  if (op === "executions") {
    const { rows } = await db.query(
      "SELECT * FROM orchestrator.execution_attempts WHERE job_id=$1 ORDER BY attempt",
      [id],
    );
    return json({ executions: rows });
  }
  if (op === "changes" || op === "diff") {
    const kind = z
      .enum(["execution", "pull_request"])
      .parse(url.searchParams.get("kind") ?? "execution");
    const attempt = z.coerce
      .number()
      .int()
      .min(1)
      .max(3)
      .parse(url.searchParams.get("attempt") ?? Math.max(1, job.attempt_count));
    const {
      rows: [artifact],
    } = await db.query(
      "SELECT files,diff FROM orchestrator.change_artifacts WHERE job_id=$1 AND attempt=$2 AND kind=$3",
      [id, attempt, kind],
    );
    if (!artifact) return json({ error: "Changes not available" }, 404);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(160000)
      .parse(url.searchParams.get("offset") ?? 0);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(op === "diff" ? 16000 : 100)
      .parse(url.searchParams.get("limit") ?? (op === "diff" ? 16000 : 100));
    const data = op === "diff" ? artifact.diff : artifact.files;
    return json({
      [op === "diff" ? "diff" : "files"]: data.slice(offset, offset + limit),
      offset,
      next_offset: offset + limit < data.length ? offset + limit : null,
      kind,
      attempt,
    });
  }
  return null;
}
