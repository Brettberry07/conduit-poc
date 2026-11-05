import { parseArgs } from "node:util";
import { z } from "zod";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { adminDatabase } from "./admin";
import {
  localProjects,
  storage,
  worktreePath,
  git,
  remoteHead,
  validateRepository,
} from "../worker/development/git";
import { GitHub, type Project } from "../worker/development/github";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "job-id": { type: "string" } },
});
const command = positionals[0];
async function main() {
  if (!["inspect", "retry", "cleanup"].includes(command))
    throw Error("Use inspect|retry|cleanup --job-id JOB_UUID");
  const id = z.string().uuid().parse(values["job-id"]),
    db = adminDatabase();
  try {
    const {
      rows: [record],
    } = await db.query(
      `SELECT j.id,j.root_job_id,j.status,j.attempt_count,t.*,row_to_json(p) AS project_record FROM orchestrator.jobs j JOIN orchestrator.development_tasks t ON t.job_id=j.root_job_id JOIN orchestrator.projects p ON p.id=t.project_id WHERE j.id=$1`,
      [id],
    );
    if (!record) throw Error("Development job not found");
    const config = (await localProjects()).find(
      (c) => c.project_id === record.project_id,
    );
    if (!config) throw Error("No approved local project configuration");
    const { root, repository } = await storage(config),
      p = record.project_record as Project,
      workspace = worktreePath(root, p, record.root_job_id);
    const lock = join(root, "locks", p.id, record.root_job_id + ".lock");
    const statePath = join(root, "executions", p.id, id + ".json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (command === "inspect") {
      console.log(
        JSON.stringify(
          {
            job_id: id,
            status: record.status,
            attempt_count: record.attempt_count,
            publication_state: record.publication_state,
            branch: record.branch,
            worktree: workspace,
            recovery_state: statePath,
            stage: state.stage,
            pull_request: record.pull_request,
          },
          null,
          2,
        ),
      );
      return;
    }
    // Never steal a branch lock or a live lease. SIGKILL locks require explicit operator review.
    try {
      await lstat(lock);
      throw Error(
        "Branch lock exists; verify process exit before manually removing that lock",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (command === "retry") {
      if (
        !["prepared", "verified", "committed", "pushed", "published"].includes(
          state.stage,
        )
      )
        throw Error(
          "Only intact prepared or verified publication state can be retried. Interrupted execution/unverified edits require manual inspection and a fresh job.",
        );
      const { rowCount } = await db.query(
        `UPDATE orchestrator.jobs SET status='queued',completed_at=NULL,error=NULL,phase=NULL WHERE id=$1 AND status IN ('failed','blocked') AND attempt_count<3 AND NOT EXISTS(SELECT 1 FROM orchestrator.jobs active WHERE active.root_job_id=$2 AND active.status='running')`,
        [id, record.root_job_id],
      );
      if (!rowCount)
        throw Error(
          "Job is active, exhausted, or otherwise not eligible for safe retry",
        );
      console.log("Queued recovery; prior execution attempt remains recorded");
      return;
    }
    if (
      record.publication_state !== "published" ||
      !record.head_commit ||
      !record.pull_request
    )
      throw Error("Cleanup requires durable published code and PR metadata");
    const {
      rows: [active],
    } = await db.query(
      `SELECT id FROM orchestrator.jobs WHERE root_job_id=$1 AND status IN ('running','queued','waiting_dependencies') LIMIT 1`,
      [record.root_job_id],
    );
    if (active)
      throw Error("Branch has active or queued work; cleanup refused");
    await validateRepository(repository, p, config.remote);
    if (
      (await git(workspace, ["symbolic-ref", "--short", "HEAD"])).trim() !==
      record.branch
    )
      throw Error("Unexpected worktree branch");
    if (
      (
        await git(workspace, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored",
        ])
      ).trim()
    )
      throw Error(
        "Uncommitted, untracked or ignored content exists; preserve/archive it manually before cleanup",
      );
    if ((await git(workspace, ["ls-files", "-u"])).trim())
      throw Error("Unresolved conflicts exist");
    const head = (await git(workspace, ["rev-parse", "HEAD"])).trim(),
      github = await GitHub.fromEnvironment();
    if (
      head !== record.head_commit ||
      (await remoteHead(
        repository,
        p.repository_url,
        record.branch,
        github.gitToken(),
      )) !== head
    )
      throw Error("Branch contains unpublished commits or remote head changed");
    const pr = await github.read(p, record.pull_request.number);
    if (pr.head !== head) throw Error("GitHub PR head differs from local head");
    await git(repository, ["worktree", "remove", "--", workspace]);
    console.log(
      "Removed only the clean, published linked worktree. Branch, GitHub PR and execution history retained.",
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    e instanceof Error && !("code" in e)
      ? e.message
      : "Development administration failed; check private configuration and database permissions",
  );
  process.exitCode = 1;
});
