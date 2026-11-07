import { z } from "zod";
import { transaction, type DB } from "./db";
import { DevelopmentError } from "./development";
import { consumerName, readEventConsumer, readEventPage } from "./event-api";
import { workerAvailableSql } from "./queue";

export const MONITOR_ATTENTION_LIMIT = 20;

const monitorQuery = z.object({ consumer: consumerName }).strict();

// This projection keeps historical attempts out of the current family outcome.
// Physical running and waiting jobs are counted separately, including revisions.
const snapshotSql = `
  WITH owned_jobs AS (
    SELECT j.id,j.root_job_id,j.task,j.status,j.created_at,j.lease_expires_at,j.project_id,
      j.dependency_job_ids,i.id AS initiative_id,i.status AS initiative_status,it.task_key
    FROM orchestrator.jobs j
    LEFT JOIN orchestrator.initiative_tasks it ON it.root_job_id=j.root_job_id AND it.owner=j.submitter_id
    LEFT JOIN orchestrator.initiatives i ON i.id=it.initiative_id AND i.owner=it.owner
    WHERE j.submitter_id=$1 AND (it.initiative_id IS NULL OR i.status IN ('active','paused'))
  ), latest_jobs AS (
    SELECT DISTINCT ON (coalesce(root_job_id,id)) *
    FROM owned_jobs ORDER BY coalesce(root_job_id,id),created_at DESC,id DESC
  ), job_conditions AS (
    SELECT j.*,p.pull_request->>'draft'='true' AS draft_pr,
      CASE
        WHEN j.status IN ('waiting_dependencies','blocked') AND EXISTS (
          SELECT 1 FROM unnest(j.dependency_job_ids) dep(id)
          JOIN orchestrator.jobs d ON d.id=dep.id AND d.submitter_id=$1
          LEFT JOIN orchestrator.development_tasks dp ON dp.job_id=d.id
          WHERE dp.pull_request->>'merged' IS DISTINCT FROM 'true'
            AND (d.status IN ('failed','blocked') OR dp.pull_request->>'state'='closed')
        ) THEN 'dependency_blocked'
        WHEN j.status IN ('failed','blocked') THEN 'inspect_failure'
        WHEN j.status='completed' AND j.task='development'
          AND p.pull_request->>'merged' IS DISTINCT FROM 'true' THEN
          CASE p.pull_request->>'state'
            WHEN 'open' THEN 'review_pr'
            WHEN 'closed' THEN 'pr_closed'
            ELSE 'inspect_publication'
          END
        WHEN j.status='waiting_dependencies' THEN 'wait_for_dependency'
      END AS type
    FROM latest_jobs j
    LEFT JOIN orchestrator.jobs root ON root.id=j.root_job_id AND root.submitter_id=$1
    LEFT JOIN orchestrator.development_tasks p ON p.job_id=root.id
  ), conditions AS (
    SELECT type,initiative_id,task_key,id AS job_id,id AS condition_ref,
      CASE type
        WHEN 'dependency_blocked' THEN 'A prerequisite job failed, was blocked, or its PR closed without merge'
        WHEN 'inspect_failure' THEN 'The latest job in this work item failed or was blocked'
        WHEN 'review_pr' THEN CASE WHEN draft_pr THEN 'Draft PR awaiting review' ELSE 'Open PR awaiting review or merge' END
        WHEN 'pr_closed' THEN 'The recorded PR closed without merge'
        WHEN 'inspect_publication' THEN 'Completed development job has no recorded open or merged PR'
        WHEN 'wait_for_dependency' THEN 'Waiting for prerequisite merges or queue reconciliation'
      END AS reason,
      CASE type WHEN 'review_pr' THEN 2 WHEN 'wait_for_dependency' THEN 3 ELSE 1 END AS sort_order
    FROM job_conditions WHERE type IS NOT NULL
    UNION ALL
    SELECT 'recovery_pending',initiative_id,task_key,id,id,
      'The running job lease has expired; check recovery status',1
    FROM owned_jobs WHERE status='running' AND lease_expires_at<=statement_timestamp()
    UNION ALL
    SELECT 'needs_decision',i.id,t.task_key,r.job_id,r.id,
      'The latest PM assessment requests a decision',0
    FROM orchestrator.initiatives i
    JOIN orchestrator.initiative_tasks t ON t.initiative_id=i.id AND t.owner=i.owner
    JOIN LATERAL (
      SELECT id,job_id,content->>'outcome' AS outcome FROM orchestrator.initiative_reviews r
      WHERE r.initiative_id=i.id AND r.task_key=t.task_key AND r.owner=i.owner
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) r ON r.outcome='needs_decision'
    WHERE i.owner=$1 AND i.status IN ('active','paused')
  ), attention_page AS (
    SELECT type || ':' || condition_ref AS condition_id,type,initiative_id,task_key,job_id,reason,
      CASE WHEN type='needs_decision'
        THEN '/api/initiatives/' || initiative_id || '/reviews?review_id=' || condition_ref
        ELSE '/api/jobs/' || job_id
      END AS details_url,sort_order
    FROM conditions ORDER BY sort_order,condition_id LIMIT $2
  )
  SELECT statement_timestamp() AS server_time,
    (SELECT count(*)::int FROM orchestrator.initiatives WHERE owner=$1 AND status='active') AS active_initiatives,
    (SELECT count(*)::int FROM job_conditions WHERE status IN ('failed','blocked')) AS failed_jobs,
    (SELECT count(*)::int FROM job_conditions WHERE type='review_pr') AS awaiting_review,
    count(*) FILTER (WHERE status='running')::int AS running_jobs,
    count(*) FILTER (WHERE status IN ('queued','waiting_dependencies'))::int AS waiting_jobs,
    count(*) FILTER (
      WHERE status='queued' AND initiative_status IS DISTINCT FROM 'paused'
        AND (task<>'development' OR EXISTS (
          SELECT 1 FROM orchestrator.projects p WHERE p.id=owned_jobs.project_id AND p.enabled
        ))
    )::int AS queued_for_execution,
    (SELECT coalesce(jsonb_agg(to_jsonb(a)-'sort_order' ORDER BY a.sort_order,a.condition_id),'[]')
      FROM attention_page a) AS attention,
    (SELECT jsonb_build_object(
      'available_workers', count(*) FILTER (WHERE ${workerAvailableSql}),
      'unavailable_workers', count(*) FILTER (WHERE NOT (${workerAvailableSql})),
      'last_seen_at', max(w.last_seen_at),
      'details_url', '/api/workers'
    ) FROM orchestrator.workers w) AS worker_readiness
  FROM owned_jobs
`;

export async function monitorSnapshot(
  db: DB,
  owner: string,
  params: URLSearchParams,
) {
  if (params.getAll("consumer").length > 1)
    throw new DevelopmentError("Repeated monitor query parameter", 400);
  const { consumer: name } = monitorQuery.parse(Object.fromEntries(params));
  return transaction(db, async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const consumer = await readEventConsumer(connection, owner, name);
    const activity = await readEventPage(
      connection,
      owner,
      consumer.acknowledged_cursor,
    );
    const {
      rows: [{ server_time, attention, worker_readiness, ...overview }],
    } = await connection.query(snapshotSql, [
      owner,
      MONITOR_ATTENTION_LIMIT + 1,
    ]);
    return {
      server_time,
      consumer,
      activity,
      overview,
      attention: attention.slice(0, MONITOR_ATTENTION_LIMIT),
      attention_has_more: attention.length > MONITOR_ATTENTION_LIMIT,
      worker_readiness,
    };
  });
}
