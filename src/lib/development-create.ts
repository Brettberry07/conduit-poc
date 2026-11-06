import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import { developmentInput, featureBranch } from "./development";
import { policyVersion } from "./agent-protocol";
import { publicColumns } from "./queue";

// Caller validates project, policy and dependencies. Can run inside activation's transaction.
export async function insertDevelopmentRoot(
  db: DB,
  principal: string,
  requestId: string,
  input: z.infer<typeof developmentInput>,
  branch: string,
  id = randomUUID(),
) {
  const {
    rows: [job],
  } = await db.query(
    `WITH created AS (INSERT INTO orchestrator.jobs(id,title,description,task,submitter_id,request_id,instructions,acceptance_criteria,project_id,root_job_id,base_branch,dependency_job_ids,status,original_request,development_mode,policy_version,research,accepted_policy_version)
   VALUES($1,$2,$3,'development',$4,$5,$6,$7,$8,$1,$9,$10,CASE WHEN cardinality($10::uuid[])>0 THEN 'waiting_dependencies' ELSE 'queued' END,$12,$13,$14,$15,$16)
   ON CONFLICT(submitter_id,request_id) DO UPDATE SET request_id=excluded.request_id RETURNING *),
   registered AS (INSERT INTO orchestrator.development_tasks(job_id,project_id,branch,base_branch)
    SELECT id,project_id,$11,base_branch FROM created WHERE task='development' AND root_job_id=id ON CONFLICT(job_id) DO NOTHING)
   SELECT ${publicColumns} FROM created`,
    [
      id,
      input.title,
      input.description,
      principal,
      requestId,
      input.instructions,
      input.acceptance_criteria,
      input.project_id,
      branch,
      input.dependency_job_ids,
      featureBranch(id, input.title),
      input.original_request ?? input.instructions,
      input.development_mode,
      input.policy_version ?? null,
      input.research ?? null,
      policyVersion(),
    ],
  );
  return job;
}
