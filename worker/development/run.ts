import { mkdir, readFile, writeFile, rename, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Call, ClaimedJob } from "../runner";
import { Blocked, GitHub, type Project, type PullRequest } from "./github";
import {
  git,
  storage,
  localProjects,
  initializeRepository,
  validateRepository,
  fetchBranch,
  worktreePath,
  createWorktree,
  assertHead,
  remoteHead,
  safePush,
  type LocalProject,
} from "./git";
import { captureChanges, commitChanges, type Changes } from "./changes";
import { executeWorktree, type Execution } from "./executor";
export type Publication = {
  job_id: string;
  project_id: string;
  branch: string;
  base_branch: string;
  base_commit: string | null;
  head_commit: string | null;
  pull_request: PullRequest | null;
};
export type DevelopmentJob = ClaimedJob & {
  project_id: string;
  root_job_id: string;
  base_branch: string;
  publication: Publication;
  project_record: Project;
};
type State = {
  version: 1;
  job_id: string;
  root_job_id: string;
  branch: string;
  start: string;
  base: string;
  expected_remote: string | null;
  stage:
    | "prepared"
    | "executing"
    | "executed"
    | "verified"
    | "committed"
    | "pushed"
    | "published";
  execution?: Execution;
  changes?: Changes;
  head?: string;
  pull_request?: PullRequest;
};
const networkDefaults = {
  initialize: initializeRepository,
  validate: validateRepository,
  fetch: fetchBranch,
  head: remoteHead,
  push: safePush,
};
export type DevelopmentDependencies = {
  github: GitHub;
  configs: LocalProject[];
  execute: typeof executeWorktree;
  network?: typeof networkDefaults;
};
export async function executeDevelopment(
  job: DevelopmentJob,
  call: Call,
  stateDir: string,
  stopping: () => boolean,
  remember: (dir: string) => Promise<void>,
  dependencies?: DevelopmentDependencies,
) {
  const p = job.project_record,
    publication = job.publication;
  let transportFailure = false,
    renewalFailure: unknown,
    renewing = false;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  const workerCall: Call = async (path, body) => {
    try {
      return await call(path, body);
    } catch (e) {
      transportFailure = true;
      throw e;
    }
  };
  const phase = async (phase: string, fields: Record<string, unknown> = {}) =>
    workerCall(`/api/jobs/${job.id}/publication`, {
      claim_token: job.claim_token,
      phase,
      ...fields,
    });
  const renew = async () => {
    if (renewalFailure) throw renewalFailure;
    if (stopping())
      throw new Blocked("Worker stopping; local changes are preserved");
    await workerCall(`/api/jobs/${job.id}/report`, {
      claim_token: job.claim_token,
      action: "progress",
      progress: 10,
    });
    await workerCall("/api/heartbeat", {});
  };
  let result: Record<string, unknown> = {
    project: p?.name,
    branch: publication?.branch,
    execution: { status: "failed" },
    verification: { status: "not_run" },
  };
  let branchLock: string | undefined;
  try {
    await renew();
    leaseTimer = setInterval(async () => {
      if (renewing || renewalFailure) return;
      renewing = true;
      try {
        await renew();
      } catch (e) {
        renewalFailure = e;
      } finally {
        renewing = false;
      }
    }, 5000);
    if (
      !p?.enabled ||
      p.id !== job.project_id ||
      !p.allowed_base_branches.includes(job.base_branch) ||
      publication.job_id !== job.root_job_id ||
      publication.project_id !== p.id ||
      publication.base_branch !== job.base_branch ||
      !publication.branch.startsWith("conduit/job-") ||
      publication.branch === p.default_branch ||
      p.allowed_base_branches.includes(publication.branch)
    )
      throw new Blocked("Project or branch is not approved");
    const network = dependencies?.network ?? networkDefaults;
    const configs = dependencies?.configs ?? (await localProjects()),
      github = dependencies?.github ?? (await GitHub.fromEnvironment());
    const config = configs.find((c) => c.project_id === p.id);
    if (!config)
      throw new Blocked(
        "Project has no administrator-approved worker-local configuration",
      );
    const githubSecurity = await github.safety(p, job.base_branch);
    result.github_security = githubSecurity;
    const { root } = await storage(config),
      repo = await network.initialize(config, p, github.gitToken());
    const executionDir = join(root, "executions", p.id),
      lockDir = join(root, "locks", p.id);
    await mkdir(executionDir, { recursive: true, mode: 0o700 });
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    branchLock = join(lockDir, job.root_job_id + ".lock");
    const file = await open(branchLock, "wx", 0o600).catch(() => {
      branchLock = undefined;
      throw new Blocked(
        "Feature branch is locally locked; verify the recorded process stopped before recovery",
      );
    });
    await file.writeFile(JSON.stringify({ pid: process.pid, job_id: job.id }));
    await file.close();
    const workspace = worktreePath(root, p, job.root_job_id),
      statePath = join(executionDir, job.id + ".json");
    let state: State | undefined;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Blocked(
          "Execution recovery state cannot be read; refusing to discard it",
        );
    }
    async function save() {
      await writeFile(statePath + ".tmp", JSON.stringify(state), {
        mode: 0o600,
      });
      await rename(statePath + ".tmp", statePath);
    }
    if (
      state &&
      (state.job_id !== job.id ||
        state.root_job_id !== job.root_job_id ||
        state.branch !== publication.branch)
    )
      throw new Blocked("Recovery state identity mismatch");
    let pr = await github.find(p, publication.branch);
    if (
      pr &&
      (pr.merged ||
        pr.state !== "open" ||
        !pr.draft ||
        (pr.base_branch && pr.base_branch !== job.base_branch))
    ) {
      await phase("publishing", {
        pull_request: pr,
        publication_state: "blocked",
      });
      throw new Blocked(
        "PR was closed, merged, or made ready; no automated changes permitted",
      );
    }
    if (!state) {
      const base = await network.fetch(
        repo,
        p.repository_url,
        job.base_branch,
        github.gitToken(),
      );
      const remote = await network.head(
        repo,
        p.repository_url,
        publication.branch,
        github.gitToken(),
      );
      const revision = job.id !== job.root_job_id;
      if (
        revision &&
        (!publication.head_commit || remote !== publication.head_commit || !pr)
      )
        throw new Blocked(
          "Revision remote head differs from the approved published head",
        );
      if (!revision && remote)
        throw new Blocked(
          "Unexpected existing remote branch without execution recovery state",
        );
      const start = revision
        ? await network.fetch(
            repo,
            p.repository_url,
            publication.branch,
            github.gitToken(),
          )
        : base;
      await createWorktree(repo, workspace, publication.branch, start);
      await assertHead(workspace, publication.branch, start);
      if (
        (
          await git(workspace, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ])
        ).trim()
      )
        throw new Blocked(
          "Worktree has unpublished changes; administrator recovery required",
        );
      state = {
        version: 1,
        job_id: job.id,
        root_job_id: job.root_job_id,
        branch: publication.branch,
        start,
        base: publication.base_commit ?? base,
        expected_remote: remote,
        stage: "prepared",
      };
      await save();
    } else {
      await createWorktree(
        repo,
        workspace,
        publication.branch,
        state.head ?? state.start,
      );
      if (state.stage === "executing")
        throw new Blocked(
          "Interrupted Codex execution has preserved workspace changes; inspect them before administrator recovery",
        );
    }
    await phase("running", {
      base_commit: state.base,
      starting_commit: state.start,
      publication_state: "prepared",
    });
    result = {
      ...result,
      starting_commit: state.start,
      base_commit: state.base,
      worktree_id: job.root_job_id,
    };
    if (state.stage === "prepared") {
      await assertHead(workspace, publication.branch, state.start);
      state.stage = "executing";
      await save();
      state.execution = await (dependencies?.execute ?? executeWorktree)(
        workspace,
        repo,
        config,
        job,
        renew,
        stopping,
        (v) => phase(v),
        remember,
      );
      state.stage = "executed";
      await save();
    }
    if (state.stage === "executed") {
      await assertHead(workspace, publication.branch, state.start);
      result.execution = {
        status: "completed",
        thread_id: state.execution?.thread_id,
      };
      const passed =
        !!state.execution?.checks.length &&
        state.execution.checks.every((c) => c.exit_code === 0 && !c.timed_out);
      result.verification = {
        status: passed ? "passed" : "failed",
        checks: state.execution?.checks ?? [],
      };
      state.changes = await captureChanges(
        workspace,
        state.start,
        config.policy,
      );
      await workerCall(`/api/jobs/${job.id}/artifacts`, {
        claim_token: job.claim_token,
        kind: "execution",
        files: state.changes.files,
        diff: state.changes.diff,
      });
      if (!passed)
        return {
          action: "failed" as const,
          progress: 100,
          result,
          error: "Verification failed; changes preserved and not published",
        };
      if (!state.changes.files.length && job.id === job.root_job_id)
        throw new Blocked(
          "No source changes were produced; no empty PR was created",
        );
      state.stage = "verified";
      await save();
    }
    if (!state.execution || !state.changes)
      throw new Blocked(
        "Recovery state is missing verified execution evidence",
      );
    result.execution = {
      status: "completed",
      thread_id: state.execution.thread_id,
    };
    result.verification = { status: "passed", checks: state.execution.checks };
    await renew();
    await phase("publishing", { publication_state: "verified" });
    if (state.stage === "verified") {
      // A crash after update-ref but before journaling can be reconciled from the exact inspected tree and parent.
      const actual = (await git(workspace, ["rev-parse", "HEAD"])).trim();
      if (actual !== state.start) {
        const parent = (
            await git(workspace, ["rev-parse", `${actual}^`])
          ).trim(),
          tree = (
            await git(workspace, ["rev-parse", `${actual}^{tree}`])
          ).trim();
        const message = (
          await git(workspace, ["log", "-1", "--format=%B"])
        ).trim();
        if (
          parent !== state.start ||
          tree !== state.changes.tree ||
          !message.includes(`Conduit job ${job.id}`)
        )
          throw new Blocked(
            "Unexpected local commit; administrator reconciliation required",
          );
        state.head = actual;
        await git(workspace, ["read-tree", actual]);
      } else
        state.head = state.changes.files.length
          ? await commitChanges(
              workspace,
              publication.branch,
              state.start,
              state.changes,
              `${job.title}\n\nConduit job ${job.id}; attempt ${job.attempt_count}`,
            )
          : state.start;
      state.stage = "committed";
      await save();
    }
    const head = state.head!;
    await assertHead(workspace, publication.branch, head!);
    if (
      (
        await git(workspace, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).trim()
    )
      throw new Blocked(
        "Workspace changed after verification; publication stopped",
      );
    await network.validate(repo, p, config.remote);
    await github.safety(p, job.base_branch);
    await renew();
    pr = await github.find(p, publication.branch);
    if (
      pr &&
      (pr.state !== "open" ||
        pr.merged ||
        !pr.draft ||
        (pr.base_branch && pr.base_branch !== job.base_branch))
    )
      throw new Blocked("Pull request no longer permits automated publication");
    await phase("publishing", {
      head_commit: head,
      publication_state: "committed",
    });
    const actualRemote = await network.head(
      repo,
      p.repository_url,
      publication.branch,
      github.gitToken(),
    );
    if (actualRemote !== head) {
      if (state.stage === "pushed" || state.stage === "published")
        throw new Blocked("Published remote branch changed unexpectedly");
      await network.push(
        repo,
        p.repository_url,
        publication.branch,
        head!,
        state.expected_remote,
        github.gitToken(),
      );
    }
    state.stage = "pushed";
    await save();
    await phase("publishing", {
      head_commit: head,
      publication_state: "pushed",
    });
    const currentBase = await network.fetch(
      repo,
      p.repository_url,
      job.base_branch,
      github.gitToken(),
    );
    const cumulative = await captureChanges(
      workspace,
      await git(workspace, ["merge-base", currentBase, head!]).then((v) =>
        v.trim(),
      ),
      config.policy,
      head!,
    );
    for (const [kind, changes] of [
      ["execution", state.changes],
      ["pull_request", cumulative],
    ] as const)
      await workerCall(`/api/jobs/${job.id}/artifacts`, {
        claim_token: job.claim_token,
        kind,
        files: changes.files,
        diff: changes.diff,
      });
    const warnings =
      "Acceptance criteria are supplied by the requester; configured checks do not prove every criterion. Diff output is bounded; inspect the full PR before human review.";
    const body = `## ${job.title}\n\nConduit job: ${job.id}\nParent task: ${job.root_job_id}\nExecution attempt: ${job.attempt_count}\nBase branch: ${job.base_branch}\nStarting commit: ${state.start}\nHead commit: ${head}\n\nImplementation: ${state.changes.summary}\n\n### Files changed (cumulative)\n${cumulative.files.map((f) => `- ${f.status}: ${f.path} (+${f.additions}/-${f.deletions})`).join("\n")}\n\n### Verification\n${state.execution.checks.map((c) => `- ${c.name}: ${c.exit_code === 0 ? "passed" : "failed"}`).join("\n")}\n\n### Warnings and limitations\n${[...githubSecurity.warnings, warnings].join("\n\n")}\n\nDraft only. Human review and merge through GitHub are required.`;
    await renew();
    const pullRequest = await github.publish(
      p,
      publication.branch,
      job.base_branch,
      job.title ?? "Development task",
      body,
    );
    if (pullRequest.head !== head)
      throw new Blocked(
        "PR head changed during publication; reconcile before another revision",
      );
    state.pull_request = pullRequest;
    state.stage = "published";
    await save();
    await phase("publishing", {
      head_commit: head,
      pull_request: pullRequest,
      publication_state: "published",
    });
    result = {
      ...result,
      head_commit: head,
      pull_request: pullRequest,
      summary: state.changes.summary,
      changes: {
        files_added: state.changes.files.filter((f) => f.status === "added")
          .length,
        files_modified: state.changes.files.filter(
          (f) => f.status === "modified",
        ).length,
        files_deleted: state.changes.files.filter((f) => f.status === "deleted")
          .length,
        files_renamed: state.changes.files.filter((f) => f.status === "renamed")
          .length,
      },
      warnings: [...githubSecurity.warnings, warnings],
    };
    return { action: "completed" as const, progress: 100, result };
  } catch (error) {
    // Transport/ownership failures return to the original durable journal path, without falsely failing a job.
    if (transportFailure || (error as any)?.status) throw error;
    const blocked = error instanceof Blocked;
    const message = blocked
      ? (error as Error).message
      : "Development execution or publication failed; workspace and recovery state preserved";
    return {
      action: blocked ? ("blocked" as const) : ("failed" as const),
      progress: 100,
      result: { ...result, recovery_required: true },
      error: message,
    };
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    if (branchLock) await rm(branchLock, { force: true });
  }
}
export async function reconcileDevelopment(call: Call) {
  if (!process.env.CONDUIT_PROJECTS_FILE) return;
  const configs = await localProjects(),
    github = await GitHub.fromEnvironment();
  const { tasks } = await call("/api/development/pending", {});
  for (const task of tasks) {
    if (!configs.some((c) => c.project_id === task.project_id)) continue;
    const pr = await github.read(task.project_record, task.pull_request.number);
    await call("/api/development/reconcile", {
      root_job_id: task.job_id,
      pull_request: pr,
    });
  }
}
