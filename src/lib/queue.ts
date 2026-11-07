import { transaction, type DB } from "./db";
import { DevelopmentError } from "./development";
export const LEASE_SECONDS = 30;
export const MAX_ATTEMPTS = 3;
export const MAX_RUNNING_JOBS_PER_OWNER = 4;
export const WORKER_HEARTBEAT_FRESH_SECONDS = 15;
export const workerAvailableSql = `w.last_seen_at>statement_timestamp()-interval '${WORKER_HEARTBEAT_FRESH_SECONDS} seconds'`;
export const publicColumns = `id,title,description,task,instructions,acceptance_criteria,original_request,development_mode,policy_version,accepted_policy_version,research,project,project_id,root_job_id,base_branch,dependency_job_ids,phase,status,created_at,claimed_at,completed_at,worker_id,result,error,attempt_count,lease_expires_at,progress`;
const unmergedDependencies = `SELECT 1 FROM unnest(j.dependency_job_ids) dep(id)
  LEFT JOIN orchestrator.development_tasks t ON t.job_id=dep.id
  WHERE t.pull_request->>'merged' IS DISTINCT FROM 'true'`;

export async function retryJob(
  db: DB,
  id: string,
  owner: string,
  expectedAttempt: number,
) {
  return transaction(db, async (connection) => {
    const {
      rows: [job],
    } = await connection.query(
      `SELECT ${publicColumns} FROM orchestrator.jobs WHERE id=$1 AND submitter_id=$2 FOR UPDATE`,
      [id, owner],
    );
    if (!job) throw new DevelopmentError("Not found", 404);
    if (job.attempt_count > expectedAttempt) return job;
    if (job.attempt_count !== expectedAttempt)
      throw new DevelopmentError("Attempt count changed; read the current job");
    if (job.status === "queued") return job;
    if (!["failed", "blocked"].includes(job.status))
      throw new DevelopmentError("Only failed or blocked jobs can be retried");
    if (job.attempt_count >= MAX_ATTEMPTS)
      throw new DevelopmentError("Job has reached its attempt limit");
    if (job.task === "development") {
      const {
        rows: [conditions],
      } = await connection.query(
        `SELECT EXISTS(${unmergedDependencies}) AS waiting,
          EXISTS(SELECT 1 FROM orchestrator.projects p WHERE p.id=j.project_id
            AND p.enabled AND j.base_branch=ANY(p.allowed_base_branches)) AS approved,
          EXISTS(SELECT 1 FROM orchestrator.initiative_tasks it
            JOIN orchestrator.initiatives i ON i.id=it.initiative_id
            WHERE it.root_job_id=j.root_job_id AND i.status<>'active') AS inactive,
          EXISTS(SELECT 1 FROM orchestrator.jobs sibling
            WHERE sibling.root_job_id=j.root_job_id AND sibling.id<>j.id
            AND (sibling.status='running' OR (sibling.created_at,sibling.id)>(j.created_at,j.id))) AS superseded,
          EXISTS(SELECT 1 FROM orchestrator.development_tasks t WHERE t.job_id=j.root_job_id
            AND t.pull_request IS NOT NULL AND (t.pull_request->>'state' IS DISTINCT FROM 'open'
              OR t.pull_request->>'draft' IS DISTINCT FROM 'true' OR t.pull_request->>'merged'='true')) AS closed
        FROM orchestrator.jobs j WHERE j.id=$1`,
        [id],
      );
      if (conditions.waiting)
        throw new DevelopmentError(
          "Every prerequisite pull request must be merged before retry",
        );
      if (!conditions.approved)
        throw new DevelopmentError("Project or base branch is not approved");
      if (conditions.inactive)
        throw new DevelopmentError(
          "Only active initiative jobs can be retried",
        );
      if (conditions.superseded)
        throw new DevelopmentError(
          "The branch has active or newer development work",
        );
      if (conditions.closed)
        throw new DevelopmentError(
          "Retry requires any existing pull request to be an open draft",
        );
    }
    const {
      rows: [queued],
    } = await connection.query(
      `UPDATE orchestrator.jobs SET status='queued',completed_at=NULL,claimed_at=NULL,
        claim_token=NULL,lease_expires_at=NULL,phase=NULL,result=NULL,error=NULL,progress=0,
        worker_id=CASE WHEN task='development' THEN worker_id ELSE NULL END
        WHERE id=$1 AND submitter_id=$2 RETURNING ${publicColumns}`,
      [id, owner],
    );
    return queued;
  });
}

export async function claim(db: DB, worker: string) {
  // Dependencies require actual GitHub merge reconciliation, never job completion alone.
  await db.query(`UPDATE orchestrator.jobs j SET status='queued' WHERE status='waiting_dependencies'
    AND NOT EXISTS (${unmergedDependencies})`);
  await db.query(`UPDATE orchestrator.jobs j SET status='blocked',completed_at=clock_timestamp(),error='Dependency failed or closed without merge'
   WHERE status='waiting_dependencies' AND EXISTS (SELECT 1 FROM unnest(j.dependency_job_ids) dep(id)
    JOIN orchestrator.jobs d ON d.id=dep.id LEFT JOIN orchestrator.development_tasks t ON t.job_id=d.id
    WHERE d.status IN ('failed','blocked') OR (t.pull_request->>'state'='closed' AND coalesce((t.pull_request->>'merged')::boolean,false)=false))`);
  await db.query(`UPDATE orchestrator.jobs j SET status='blocked',completed_at=clock_timestamp(),lease_expires_at=NULL,error='Project disabled'
   WHERE task='development' AND (status IN ('queued','waiting_dependencies') OR (status='running' AND lease_expires_at<=clock_timestamp())) AND NOT EXISTS(SELECT 1 FROM orchestrator.projects p WHERE p.id=j.project_id AND p.enabled)`);
  // Exhausted abandoned jobs become terminal on the next poll.
  await db.query(`UPDATE orchestrator.jobs SET status='failed',error='Lease expired; attempt limit reached',
    completed_at=clock_timestamp(),lease_expires_at=NULL WHERE status='running'
    AND lease_expires_at<=clock_timestamp() AND attempt_count>=${MAX_ATTEMPTS}`);
  const { rows } = await transaction(db, async (connection) => {
    // The lock must be its own statement: READ COMMITTED takes the claim's
    // snapshot after any previous claimer commits, rather than before waiting.
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('conduit-claim'))",
    );
    return connection.query(
      `WITH candidate AS (
    SELECT id, status='queued' AND attempt_count>0 AS explicit_retry
    FROM orchestrator.jobs candidate_job WHERE attempt_count<${MAX_ATTEMPTS} AND
    (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp()))
    AND (SELECT count(*) FROM orchestrator.jobs r WHERE r.status='running'
      AND r.lease_expires_at>clock_timestamp() AND r.submitter_id=candidate_job.submitter_id) < $2
    AND NOT EXISTS(SELECT 1 FROM orchestrator.initiative_tasks it JOIN orchestrator.initiatives i ON i.id=it.initiative_id
      WHERE it.root_job_id=candidate_job.root_job_id AND i.status<>'active')
    AND (task<>'development' OR (
      (status<>'queued' OR attempt_count=0 OR worker_id IS NULL OR worker_id=$1)
      AND
      EXISTS(SELECT 1 FROM orchestrator.projects p WHERE p.id=candidate_job.project_id AND p.enabled)
      AND EXISTS(SELECT 1 FROM orchestrator.development_tasks t WHERE t.job_id=candidate_job.root_job_id FOR UPDATE SKIP LOCKED)
      AND NOT EXISTS(SELECT 1 FROM orchestrator.jobs active WHERE active.root_job_id=candidate_job.root_job_id AND active.id<>candidate_job.id AND active.status='running')))
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE orchestrator.jobs j SET status='running',worker_id=$1,claim_token=gen_random_uuid(),
    claimed_at=clock_timestamp(),completed_at=NULL,result=NULL,error=NULL,progress=0,phase=CASE WHEN j.task='development' THEN 'claimed' ELSE NULL END,
    attempt_count=attempt_count+1,lease_expires_at=clock_timestamp()+interval '30 seconds'
    FROM candidate c WHERE j.id=c.id RETURNING j.*,c.explicit_retry`,
      [worker, MAX_RUNNING_JOBS_PER_OWNER],
    );
  });
  const job = rows[0];
  if (job?.task === "development") {
    const {
      rows: [metadata],
    } = await db.query(
      `SELECT row_to_json(t) AS publication,row_to_json(p) AS project_record FROM orchestrator.development_tasks t JOIN orchestrator.projects p ON p.id=t.project_id WHERE t.job_id=$1`,
      [job.root_job_id],
    );
    Object.assign(job, metadata);
  }
  return job ?? null;
}
export async function report(
  db: DB,
  id: string,
  worker: string,
  token: string,
  action: "progress" | "completed" | "failed" | "blocked",
  progress: number,
  result: unknown,
  error: string | null,
) {
  // One locked statement fences stale attempts and makes terminal retries idempotent.
  const { rows } = await db.query(
    `UPDATE orchestrator.jobs SET
    status=CASE WHEN status='running' AND $4<>'progress' THEN $4 ELSE status END,
    progress=CASE WHEN status='running' THEN greatest(progress,$5) ELSE progress END,
    result=CASE WHEN status='running' AND $4 IN ('completed','failed','blocked') THEN $6::jsonb ELSE result END,
    error=CASE WHEN status='running' AND $4 IN ('failed','blocked') THEN $7 ELSE error END,
    completed_at=CASE WHEN status='running' AND $4<>'progress' THEN clock_timestamp() ELSE completed_at END,
    lease_expires_at=CASE WHEN status='running' AND $4='progress' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END
    WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND
    ((status='running' AND lease_expires_at>clock_timestamp()) OR (status=$4 AND $4<>'progress'))
    RETURNING ${publicColumns}`,
    [
      id,
      worker,
      token,
      action,
      progress,
      JSON.stringify(result ?? null),
      error,
    ],
  );
  return rows[0] ?? null;
}
