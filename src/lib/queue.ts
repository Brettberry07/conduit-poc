import type { DB } from "./db";
export const LEASE_SECONDS = 30;
export const publicColumns = `id,title,description,task,status,created_at,claimed_at,completed_at,worker_id,result,error,attempt_count,lease_expires_at,progress`;
export async function claim(db: DB, worker: string) {
  // Exhausted abandoned jobs become terminal on the next poll.
  await db.query(`UPDATE orchestrator.jobs SET status='failed',error='Lease expired; attempt limit reached',
    completed_at=clock_timestamp(),lease_expires_at=NULL WHERE status='running'
    AND lease_expires_at<=clock_timestamp() AND attempt_count>=3`);
  const { rows } = await db.query(
    `WITH candidate AS (
    SELECT id FROM orchestrator.jobs WHERE attempt_count<3 AND
    (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp()))
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE orchestrator.jobs j SET status='running',worker_id=$1,claim_token=gen_random_uuid(),
    claimed_at=clock_timestamp(),completed_at=NULL,result=NULL,error=NULL,progress=0,
    attempt_count=attempt_count+1,lease_expires_at=clock_timestamp()+interval '30 seconds'
    FROM candidate c WHERE j.id=c.id RETURNING j.*`,
    [worker],
  );
  return rows[0] ?? null;
}
export async function report(
  db: DB,
  id: string,
  worker: string,
  token: string,
  action: "progress" | "completed" | "failed",
  progress: number,
  result: unknown,
  error: string | null,
) {
  // One locked statement fences stale attempts and makes terminal retries idempotent.
  const { rows } = await db.query(
    `UPDATE orchestrator.jobs SET
    status=CASE WHEN status='running' AND $4<>'progress' THEN $4 ELSE status END,
    progress=CASE WHEN status='running' THEN greatest(progress,$5) ELSE progress END,
    result=CASE WHEN status='running' AND $4='completed' THEN $6::jsonb ELSE result END,
    error=CASE WHEN status='running' AND $4='failed' THEN $7 ELSE error END,
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
