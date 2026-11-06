import { reviewIsStale } from "./initiative-reviews";
import type { DB } from "./db";

export async function initiativeProgress(db: DB, initiative: any) {
  const {
    rows: [project],
  } = await db.query(
    "SELECT enabled,allowed_base_branches FROM orchestrator.projects WHERE id=$1",
    [initiative.project_id],
  );
  const dispatch_reason =
    initiative.status !== "active"
      ? `Initiative ${initiative.status}; dispatch disabled`
      : !project?.enabled
        ? "Project disabled or unavailable"
        : null;
  const { rows: tasks } = await db.query(
    `SELECT t.task_key,t.spec->>'title' AS title,t.spec->>'development_mode' AS development_mode,t.spec->>'acceptance_criteria' AS acceptance_criteria,t.root_job_id,t.updated_at,
    coalesce((SELECT jsonb_agg(dependency_key ORDER BY dependency_key) FROM orchestrator.initiative_dependencies d
      WHERE d.initiative_id=t.initiative_id AND d.task_key=t.task_key),'[]') AS dependencies,
    j.id AS latest_job_id,j.status AS job_status,j.phase,j.error,j.result->'verification'->>'status' AS verification_status,
    coalesce(j.completed_at,j.claimed_at,j.created_at) AS job_updated_at,
    p.publication_state,p.head_commit,p.pull_request,p.pull_request_observed_at,p.updated_at AS publication_updated_at,
    (SELECT count(*)::int FROM orchestrator.jobs r WHERE r.root_job_id=t.root_job_id AND r.id<>t.root_job_id) AS revision_count
    FROM orchestrator.initiative_tasks t
    LEFT JOIN LATERAL (SELECT * FROM orchestrator.jobs j WHERE j.root_job_id=t.root_job_id AND j.submitter_id=t.owner
      ORDER BY j.created_at DESC,j.id DESC LIMIT 1) j ON true
    LEFT JOIN orchestrator.development_tasks p ON p.job_id=t.root_job_id
    WHERE t.initiative_id=$1 AND t.owner=$2 ORDER BY t.display_order,t.task_key`,
    [initiative.id, initiative.owner],
  );
  const { rows: reviews } = await db.query(
    `SELECT r.* FROM orchestrator.initiative_tasks t JOIN LATERAL (
    SELECT id,task_key,job_id,content,created_at FROM orchestrator.initiative_reviews r
    WHERE r.initiative_id=t.initiative_id AND r.task_key=t.task_key AND r.owner=t.owner
    ORDER BY created_at DESC,id DESC LIMIT 3) r ON true
    WHERE t.initiative_id=$1 AND t.owner=$2 ORDER BY r.created_at DESC,r.id DESC`,
    [initiative.id, initiative.owner],
  );
  const progress: Record<string, number> = {
    total: tasks.length,
    not_started: 0,
    waiting_dependencies: 0,
    queued: 0,
    running: 0,
    failed: 0,
    awaiting_review: 0,
    merged: 0,
  };
  const next_actions: any[] = [],
    unresolved_decisions: any[] = [];
  for (const t of tasks) {
    t.verification_status ??= "not_run";
    const merged = t.pull_request?.merged === true;
    // Execution of a later revision takes precedence over an older published PR.
    t.state = !t.root_job_id
      ? "not_started"
      : t.job_status === "waiting_dependencies"
        ? "waiting_dependencies"
        : t.job_status === "queued"
          ? "queued"
          : t.job_status === "running"
            ? "running"
            : ["failed", "blocked"].includes(t.job_status)
              ? "failed"
              : merged
                ? "merged"
                : t.pull_request?.state === "open"
                  ? "awaiting_review"
                  : "failed";
    t.integration_state = merged
      ? initiative.status === "completed" && t.state === "merged"
        ? "integrated_pm_confirmed"
        : "merged_observed"
      : "not_observed_merged";
    t.publication_stage = !t.pull_request
      ? "not_published"
      : merged
        ? "merged_observed"
        : t.pull_request.draft
          ? "draft_pr_published"
          : "awaiting_review_or_merge";
    t.pr_observation = {
      source: t.pull_request ? "recorded_github_observation" : "unavailable",
      observed_at: t.pull_request_observed_at,
      live: false,
      timestamp_semantics: "server_receipt_of_worker_observation",
    };
    const depTasks = tasks.filter((d) => t.dependencies.includes(d.task_key));
    t.waiting_on = depTasks
      .filter((d) => d.pull_request?.merged !== true)
      .map((d) => ({
        task_key: d.task_key,
        root_job_id: d.root_job_id,
        reason: ["failed", "blocked"].includes(d.job_status)
          ? "Dependency failed or blocked"
          : d.pull_request?.state === "closed"
            ? "Dependency PR closed without merge"
            : "Prerequisite PR merge has not been observed",
      }));
    t.blocking_reason =
      dispatch_reason &&
      ["queued", "waiting_dependencies", "not_started"].includes(t.state)
        ? dispatch_reason
        : t.state === "waiting_dependencies"
          ? t.waiting_on.length
            ? "Waiting for prerequisite PRs to merge on the approved base branch"
            : "Merges observed; waiting for the existing queue to reconcile readiness"
          : t.state === "failed"
            ? (t.error ?? "No open or merged PR observed; inspect job evidence")
            : ["paused", "cancelled"].includes(initiative.status) &&
                ["queued", "not_started"].includes(t.state)
              ? `Initiative ${initiative.status}; dispatch disabled`
              : null;
    t.last_update_at = [
      t.updated_at,
      t.job_updated_at,
      t.publication_updated_at,
    ]
      .filter(Boolean)
      .sort((a, b) => +new Date(b) - +new Date(a))[0];
    t.links = t.root_job_id
      ? Object.fromEntries(
          [
            "job",
            "changes",
            "diff",
            "publication",
            "executions",
            "revisions",
          ].map((op) => [
            op,
            `/api/jobs/${op === "publication" || op === "revisions" ? t.root_job_id : t.latest_job_id}${op === "job" ? "" : `/${op}`}`,
          ]),
        )
      : {};
    t.reviews = reviews
      .filter((r) => r.task_key === t.task_key)
      .map((r) => ({
        id: r.id,
        task_key: r.task_key,
        job_id: r.job_id,
        created_at: r.created_at,
        content: {
          outcome: r.content.outcome,
          observed_head_sha: r.content.observed_head_sha ?? null,
          summary: r.content.summary.slice(0, 600),
          summary_truncated: r.content.summary.length > 600,
          outstanding_concerns_count: r.content.outstanding_concerns.length,
          outstanding_concerns: r.content.outstanding_concerns
            .slice(0, 3)
            .map((s: string) => s.slice(0, 240)),
        },
        stale: reviewIsStale(
          r.content.observed_head_sha,
          t.head_commit,
          t.pull_request?.head,
          r.job_id,
          t.latest_job_id,
        ),
        full_record_url: `/api/initiatives/${initiative.id}/reviews`,
      }));
    const latest = t.reviews[0];
    if (latest?.content.outcome === "needs_decision")
      unresolved_decisions.push({
        task_key: t.task_key,
        review_id: latest.id,
        summary: latest.content.summary,
        concerns: latest.content.outstanding_concerns,
        stale: latest.stale,
        full_record_url: latest.full_record_url,
        concerns_total: latest.content.outstanding_concerns_count,
      });
    progress[t.state]++;
    const action =
      t.state === "awaiting_review"
        ? "review_pr"
        : t.state === "failed"
          ? "inspect_failure"
          : t.state === "waiting_dependencies"
            ? "wait_for_dependency"
            : null;
    if (action)
      next_actions.push({
        type: action,
        task_key: t.task_key,
        job_id: t.latest_job_id,
        pr_url: t.pull_request?.url ?? null,
      });
    if (latest?.stale)
      next_actions.push({ type: "refresh_assessment", task_key: t.task_key });
  }
  if (initiative.status === "draft")
    next_actions.push({ type: "review_plan_and_activate_if_authorized" });
  if (progress.merged === progress.total && initiative.status === "active")
    next_actions.push({ type: "verify_overall_acceptance_before_completion" });
  return {
    tasks,
    dispatch: { enabled: !dispatch_reason, reason: dispatch_reason },
    progress,
    next_actions,
    unresolved_decisions,
    outstanding_failures: tasks
      .filter((t) => t.state === "failed")
      .map((t) => ({
        task_key: t.task_key,
        job_id: t.latest_job_id,
        reason: t.blocking_reason,
      })),
    review_history: {
      included_per_task: 3,
      summaries_only: true,
      more: `/api/initiatives/${initiative.id}/reviews`,
    },
  };
}
