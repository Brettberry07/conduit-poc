import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { transaction, type DB } from "./db";
import type { Identity } from "./keys";
import {
  approvedProject,
  developmentInput,
  DevelopmentError,
} from "./development";
import { requireCurrentPolicy } from "./agent-protocol";
import { insertDevelopmentRoot } from "./development-create";
import { DEVELOPMENT_BODY_LIMIT } from "./research";
import {
  INITIATIVE_BODY_LIMIT,
  createInitiative,
  editInitiative,
  activationInput,
  lifecycleInput,
  initiativePlan,
  reviewInput,
  type InitiativePlan,
} from "./initiatives";
import { reviewIsStale } from "./initiative-reviews";
import { initiativeProgress } from "./initiative-progress";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const conflict = (message: string): never => {
  throw new DevelopmentError(message);
};
function same(a: unknown, b: unknown) {
  if (!isDeepStrictEqual(a, b))
    conflict("Idempotency key already used with different content");
}
async function owned(db: DB, id: string, owner: string, lock = false) {
  const {
    rows: [i],
  } = await db.query(
    `SELECT * FROM orchestrator.initiatives WHERE id=$1 AND owner=$2${lock ? " FOR UPDATE" : ""}`,
    [id, owner],
  );
  if (!i) throw new DevelopmentError("Not found", 404);
  return i;
}
async function savePlan(
  db: DB,
  i: any,
  plan: InitiativePlan,
  explanation?: string,
) {
  await db.query(
    `DELETE FROM orchestrator.initiative_dependencies WHERE initiative_id=$1`,
    [i.id],
  );
  await db.query(
    `DELETE FROM orchestrator.initiative_tasks WHERE initiative_id=$1 AND NOT(task_key=ANY($2::text[]))`,
    [i.id, plan.tasks.map((t) => t.task_key)],
  );
  for (const [order, t] of plan.tasks.entries())
    await db.query(
      `INSERT INTO orchestrator.initiative_tasks(initiative_id,task_key,owner,project_id,spec,display_order)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(initiative_id,task_key) DO UPDATE SET spec=excluded.spec,display_order=excluded.display_order,updated_at=clock_timestamp()`,
      [i.id, t.task_key, i.owner, plan.project_id, t, order],
    );
  for (const t of plan.tasks)
    for (const dep of t.dependencies)
      await db.query(
        `INSERT INTO orchestrator.initiative_dependencies VALUES($1,$2,$3)`,
        [i.id, t.task_key, dep],
      );
  await db.query(
    `INSERT INTO orchestrator.initiative_plan_versions(initiative_id,owner,version,snapshot,explanation) VALUES($1,$2,$3,$4,$5)`,
    [i.id, i.owner, i.plan_version, plan, explanation ?? null],
  );
}
async function jobMapping(db: DB, id: string) {
  return (
    await db.query(
      `SELECT task_key,root_job_id FROM orchestrator.initiative_tasks WHERE initiative_id=$1 ORDER BY display_order`,
      [id],
    )
  ).rows;
}
export async function initiativeApi(
  req: Request,
  db: DB,
  key: Identity,
  readBody: (req: Request, max?: number) => Promise<any>,
): Promise<Response | null> {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  if (!/^\/api\/initiatives(?:\/|$)/.test(path)) return null;
  if (path === "/api/initiatives") {
    if (method === "GET") {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      if (before) z.string().uuid().parse(before);
      const { rows } = await db.query(
        `SELECT id,project_id,plan->>'title' AS title,plan->>'goal' AS goal,status,plan_version,created_at,updated_at,completed_at FROM orchestrator.initiatives
        WHERE owner=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM orchestrator.initiatives WHERE id=$2 AND owner=$1)) ORDER BY created_at DESC,id DESC LIMIT $3`,
        [key.principal, before, limit],
      );
      return json({
        initiatives: rows,
        next_before: rows.length === limit ? rows.at(-1)?.id : null,
      });
    }
    if (method !== "POST") return null;
    const input = createInitiative.parse(
      await readBody(req, INITIATIVE_BODY_LIMIT),
    );
    const requestId = z
      .string()
      .uuid()
      .parse(req.headers.get("idempotency-key"));
    return transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `initiative-create:${key.principal}:${requestId}`,
      ]);
      const {
        rows: [existing],
      } = await c.query(
        `SELECT * FROM orchestrator.initiatives WHERE owner=$1 AND request_id=$2`,
        [key.principal, requestId],
      );
      if (existing) {
        same(existing.creation_content, input.plan);
        return json({ initiative: existing }, 201);
      }
      requireCurrentPolicy(input.policy_version);
      await approvedProject(c, input.plan.project_id, input.plan.base_branch);
      const {
        rows: [i],
      } = await c.query(
        `INSERT INTO orchestrator.initiatives(owner,project_id,request_id,creation_content,plan) VALUES($1,$2,$3,$4,$4) RETURNING *`,
        [key.principal, input.plan.project_id, requestId, input.plan],
      );
      await savePlan(c, i, input.plan);
      return json({ initiative: i }, 201);
    });
  }
  const match = path.match(
    /^\/api\/initiatives\/([^/]+)(?:\/(plan|activate|resume|reviews))?$/,
  );
  if (!match) return null;
  const id = z.string().uuid().parse(match[1]),
    op = match[2];
  if (method === "GET")
    return transaction(db, async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const i = await owned(c, id, key.principal);
      if (op === "plan") {
        const version = url.searchParams.get("version");
        if (version) {
          const v = z.coerce.number().int().positive().parse(version);
          const {
            rows: [p],
          } = await c.query(
            `SELECT version,snapshot,explanation,created_at FROM orchestrator.initiative_plan_versions WHERE initiative_id=$1 AND owner=$2 AND version=$3`,
            [id, key.principal, v],
          );
          return p
            ? json({
                plan_version: p.version,
                plan: p.snapshot,
                explanation: p.explanation,
                created_at: p.created_at,
              })
            : json({ error: "Not found" }, 404);
        }
        return json({
          plan_version: i.plan_version,
          plan: i.plan,
          tasks: await jobMapping(c, id),
        });
      }
      if (op === "reviews") {
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(url.searchParams.get("limit") ?? 50);
        const before = url.searchParams.get("before");
        if (before) z.string().uuid().parse(before);
        const reviewId = z
          .string()
          .uuid()
          .nullable()
          .parse(url.searchParams.get("review_id"));
        const { rows } = await c.query(
          `SELECT r.*,p.head_commit,p.pull_request,j.id AS latest_job_id FROM orchestrator.initiative_reviews r
        JOIN orchestrator.development_tasks p ON p.job_id=r.root_job_id
        JOIN LATERAL (SELECT id FROM orchestrator.jobs WHERE root_job_id=r.root_job_id ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
        WHERE r.initiative_id=$1 AND r.owner=$2 AND ($3::uuid IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM orchestrator.initiative_reviews WHERE id=$3 AND initiative_id=$1 AND owner=$2))
        AND ($5::uuid IS NULL OR r.id=$5) ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,
          [id, key.principal, before, limit, reviewId],
        );
        return json({
          reviews: rows.map((r) => ({
            ...r,
            stale: reviewIsStale(
              r.content.observed_head_sha,
              r.head_commit,
              r.pull_request?.head,
              r.job_id,
              r.latest_job_id,
            ),
          })),
          next_before: rows.length === limit ? rows.at(-1)?.id : null,
        });
      }
      const state = await initiativeProgress(c, i);
      // Resume omits research bodies and implementation instructions, linking the full plan.
      const initiative =
        op === "resume"
          ? {
              id: i.id,
              project_id: i.project_id,
              title: i.plan.title,
              description: i.plan.description,
              original_request: i.plan.original_request,
              goal: i.plan.goal,
              acceptance_criteria: i.plan.acceptance_criteria,
              development_mode: i.plan.development_mode,
              status: i.status,
              plan_version: i.plan_version,
              completed_at: i.completed_at,
              completion_summary: i.completion_summary,
              plan_url: `/api/initiatives/${id}/plan`,
            }
          : i;
      if (op !== "resume") return json({ initiative, ...state });
      const {
        rows: [latest],
      } = await c.query(
        `SELECT cursor::text FROM orchestrator.events WHERE owner=$1 AND initiative_id=$2
         ORDER BY orchestrator.events.cursor DESC LIMIT 1`,
        [key.principal, id],
      );
      return json({
        initiative,
        ...state,
        activity: {
          latest_cursor: latest?.cursor ?? null,
          history_url: `/api/agent/events?initiative_id=${id}`,
        },
      });
    });
  if (method === "PATCH" && op === "plan") {
    const input = editInitiative.parse(
      await readBody(req, INITIATIVE_BODY_LIMIT),
    );
    return transaction(db, async (c) => {
      const i = await owned(c, id, key.principal, true);
      if (i.status !== "draft" || i.activated_at)
        conflict("Submitted plans are immutable; use existing job revisions");
      if (i.plan_version !== input.expected_plan_version)
        conflict("Plan version conflict");
      if (i.project_id !== input.plan.project_id)
        conflict("An initiative cannot change projects");
      await approvedProject(c, input.plan.project_id, input.plan.base_branch);
      const {
        rows: [updated],
      } = await c.query(
        `UPDATE orchestrator.initiatives SET plan=$2,plan_version=plan_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id, input.plan],
      );
      await savePlan(c, updated, input.plan, input.explanation);
      return json({ initiative: updated });
    });
  }
  if (method === "POST" && op === "activate") {
    const input = activationInput.parse(await readBody(req));
    const requestId = z
      .string()
      .uuid()
      .parse(req.headers.get("idempotency-key"));
    return transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `initiative-activate:${key.principal}:${requestId}`,
      ]);
      const i = await owned(c, id, key.principal, true);
      const content = { expected_plan_version: input.expected_plan_version };
      const {
        rows: [used],
      } = await c.query(
        `SELECT id FROM orchestrator.initiatives WHERE owner=$1 AND activation_request_id=$2`,
        [key.principal, requestId],
      );
      if (used && used.id !== id)
        conflict("Idempotency key already used with different content");
      if (i.activated_at) {
        if (i.activation_request_id !== requestId)
          conflict(
            "Initiative already activated; retrieve its saved task job IDs",
          );
        same(i.activation_content, content);
        return json({ initiative_id: id, jobs: await jobMapping(c, id) }, 201);
      }
      if (i.status !== "draft")
        conflict("Only draft initiatives can be activated");
      if (i.plan_version !== input.expected_plan_version)
        conflict("Plan version conflict");
      requireCurrentPolicy(input.policy_version);
      const plan = initiativePlan.parse(i.plan);
      // Registration is read-only to the runtime. Recheck at activation; existing
      // claim/publication fences independently enforce subsequent admin disables.
      const { branch } = await approvedProject(
        c,
        i.project_id,
        plan.base_branch,
      );
      const ids = new Map(plan.tasks.map((t) => [t.task_key, randomUUID()]));
      for (const t of plan.tasks) {
        const job = developmentInput.parse({
          task: "development",
          project_id: i.project_id,
          base_branch: branch,
          title: t.title,
          description: t.description,
          instructions: t.instructions,
          acceptance_criteria: t.acceptance_criteria,
          original_request: plan.original_request,
          development_mode: t.development_mode,
          research: t.research,
          policy_version: input.policy_version,
          dependency_job_ids: t.dependencies.map((dep) => ids.get(dep)),
        });
        if (Buffer.byteLength(JSON.stringify(job)) > DEVELOPMENT_BODY_LIMIT)
          throw new DevelopmentError(
            `Task ${t.task_key} exceeds the development request byte limit`,
            400,
          );
        const created = await insertDevelopmentRoot(
          c,
          key.principal,
          randomUUID(),
          job,
          branch,
          ids.get(t.task_key),
        );
        await c.query(
          `UPDATE orchestrator.initiative_tasks SET root_job_id=$3,updated_at=clock_timestamp() WHERE initiative_id=$1 AND task_key=$2`,
          [id, t.task_key, created.id],
        );
      }
      await c.query(
        `UPDATE orchestrator.initiatives SET status='active',activation_request_id=$2,activation_content=$3,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [id, requestId, content],
      );
      return json({ initiative_id: id, jobs: await jobMapping(c, id) }, 201);
    });
  }
  if (method === "POST" && op === "reviews") {
    const input = reviewInput.parse(await readBody(req, 65536));
    const requestId = z
      .string()
      .uuid()
      .parse(req.headers.get("idempotency-key"));
    return transaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `initiative-review:${key.principal}:${requestId}`,
      ]);
      await owned(c, id, key.principal, true);
      const {
        rows: [existing],
      } = await c.query(
        `SELECT * FROM orchestrator.initiative_reviews WHERE owner=$1 AND request_id=$2`,
        [key.principal, requestId],
      );
      if (existing) {
        same(
          { initiative_id: existing.initiative_id, content: existing.content },
          { initiative_id: id, content: input },
        );
        return json({ review: existing }, 201);
      }
      const {
        rows: [task],
      } = await c.query(
        `SELECT t.root_job_id FROM orchestrator.initiative_tasks t JOIN orchestrator.jobs j ON j.root_job_id=t.root_job_id AND j.submitter_id=t.owner
        WHERE t.initiative_id=$1 AND t.task_key=$2 AND t.owner=$3 AND j.id=$4`,
        [id, input.task_key, key.principal, input.job_id],
      );
      if (!task)
        throw new DevelopmentError(
          "Review must reference this task's owned job or revision",
          400,
        );
      const {
        rows: [review],
      } = await c.query(
        `INSERT INTO orchestrator.initiative_reviews(initiative_id,task_key,owner,root_job_id,job_id,request_id,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          id,
          input.task_key,
          key.principal,
          task.root_job_id,
          input.job_id,
          requestId,
          input,
        ],
      );
      return json({ review }, 201);
    });
  }
  if (method === "PATCH" && !op) {
    const input = lifecycleInput.parse(await readBody(req));
    if (
      key.scopes.includes("console:action") &&
      !key.scopes.includes("jobs:revise") &&
      !["paused", "active", "cancelled"].includes(input.status)
    )
      return json({ error: "Forbidden" }, 403);
    return transaction(db, async (c) => {
      // Same lock as claims: a pause returning successfully fences subsequent dispatch.
      await c.query("SELECT pg_advisory_xact_lock(hashtext('conduit-claim'))");
      const i = await owned(c, id, key.principal, true);
      if (i.status !== input.expected_status)
        conflict("Lifecycle status conflict");
      if (
        input.status === "active" &&
        (i.status !== "paused" || !i.activated_at)
      )
        conflict("Use activation for a draft plan");
      if (input.status === "paused" && i.status !== "active")
        conflict("Only active initiatives can be paused");
      if (input.status === "completed") {
        const state = await initiativeProgress(c, i);
        if (
          !input.completion_summary ||
          !i.activated_at ||
          state.progress.merged !== state.progress.total ||
          state.unresolved_decisions.length
        )
          conflict(
            "Completion requires all task PRs observed merged, no unresolved decisions, and an overall acceptance summary",
          );
      }
      if (input.status === "active")
        await approvedProject(c, i.project_id, i.plan.base_branch);
      const {
        rows: [updated],
      } = await c.query(
        `UPDATE orchestrator.initiatives SET status=$2,completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE NULL END,completion_summary=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id, input.status, input.completion_summary ?? null],
      );
      return json({ initiative: updated });
    });
  }
  return null;
}
