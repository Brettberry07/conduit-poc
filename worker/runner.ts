import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
export type ClaimedJob = {
  id: string;
  claim_token: string;
  task:
    "simulate-development" | "simulate-failure" | "codex_task" | "development";
  title?: string;
  instructions?: string;
  acceptance_criteria?: string;
  original_request?: string | null;
  development_mode?: "normal" | "detailed";
  policy_version?: string | null;
  research?: import("../src/lib/research").Research | null;
  project?: string;
  worker_id?: string;
  attempt_count?: number;
  explicit_retry?: boolean;
};
type Journal = {
  job: ClaimedJob;
  attempt_dir?: string;
  outcome?: {
    action: "completed" | "failed" | "blocked";
    progress: number;
    result?: Record<string, unknown>;
    error?: string;
  };
};
export class ApiError extends Error {
  constructor(public status: number) {
    super(`API returned ${status}`);
  }
}
export type Call = (path: string, body?: unknown) => Promise<any>;
export const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
const journalRefusal = () =>
  Error("Cannot read journal; refusing to discard recovery state");

async function readJournal(path: string): Promise<Journal> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      !value.job ||
      typeof value.job.id !== "string" ||
      !value.job.id ||
      typeof value.job.claim_token !== "string" ||
      !value.job.claim_token ||
      ![
        "simulate-development",
        "simulate-failure",
        "codex_task",
        "development",
      ].includes(value.job.task) ||
      (value.attempt_dir !== undefined &&
        typeof value.attempt_dir !== "string") ||
      (value.outcome !== undefined &&
        (!value.outcome ||
          !["completed", "failed", "blocked"].includes(value.outcome.action) ||
          typeof value.outcome.progress !== "number"))
    )
      throw journalRefusal();
    return value;
  } catch {
    throw journalRefusal();
  }
}

// Validate all recovery files before execution, including the previous format.
export async function recoverJournals(stateDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw journalRefusal();
  }
  const paths = names
    .filter(
      (name) => name === "journal.json" || /^journal-.+\.json$/.test(name),
    )
    .sort()
    .map((name) => join(stateDir, name));
  const claims = new Set<string>();
  for (const path of paths) {
    const { job } = await readJournal(path);
    const claim = JSON.stringify([job.id, job.claim_token]);
    if (claims.has(claim)) throw journalRefusal();
    claims.add(claim);
  }
  return paths;
}

export async function cycle(
  call: Call,
  stateDir: string,
  wait: (ms: number) => Promise<void>,
  stopping: () => boolean = () => false,
  journalPath?: string | null,
  onJournal?: (path: string) => void,
  idleHeartbeat = true,
) {
  if (stopping()) return false;
  let path =
    journalPath === undefined
      ? (await recoverJournals(stateDir))[0]
      : (journalPath ?? undefined);
  if (idleHeartbeat) await call("/api/heartbeat", {});
  let journal: Journal;
  if (path) {
    journal = await readJournal(path);
    onJournal?.(path);
  } else {
    if (stopping()) return false;
    const { job } = await call("/api/claim", {});
    if (!job) return false;
    journal = { job };
    // A new claim can arrive before the prior agent removes its terminal journal.
    const attempt =
      job.attempt_count > 1 ? `-attempt-${job.attempt_count}` : "";
    path = join(
      stateDir,
      `journal-${encodeURIComponent(job.id)}${attempt}.json`,
    );
    onJournal?.(path);
    await save(journal);
    log("claimed", { job_id: job.id });
  }
  async function save(value: Journal) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(path + ".tmp", path!);
  }
  const { job } = journal;
  const report = (value: unknown) =>
    call(`/api/jobs/${job.id}/report`, {
      claim_token: job.claim_token,
      ...(value as object),
    });
  try {
    if (!journal.outcome) {
      if (job.task === "development") {
        const { executeDevelopment } = await import("./development/run");
        const { cleanupAttemptAuth } = await import("./codex");
        if (journal.attempt_dir) await cleanupAttemptAuth(journal.attempt_dir);
        journal.outcome = await executeDevelopment(
          job as import("./development/run").DevelopmentJob,
          call,
          stateDir,
          stopping,
          async (attempt) => {
            journal.attempt_dir = attempt;
            await save(journal);
          },
        );
        await save(journal);
      } else if (job.task === "codex_task") {
        const { executeCodex, cleanupAttemptAuth } = await import("./codex");
        if (journal.attempt_dir) await cleanupAttemptAuth(journal.attempt_dir);
        journal.outcome = await executeCodex(
          job,
          async () => {
            await report({ action: "progress", progress: 10 });
            await call("/api/heartbeat", {});
          },
          stopping,
          async (attempt) => {
            journal.attempt_dir = attempt;
            await save(journal);
          },
        );
        await save(journal);
      } else {
        // Renew before every bounded simulation step. A failed request stops work immediately.
        for (let step = 0; step < 5; step++) {
          if (stopping()) return false;
          await report({ action: "progress", progress: step * 20 });
          await call("/api/heartbeat", {});
          log("progress", { job_id: job.id, step: step + 1 });
          await wait(1000);
        }
        if (
          job.task !== "simulate-development" &&
          job.task !== "simulate-failure"
        )
          throw Error("Unsupported task");
        journal.outcome =
          job.task === "simulate-failure"
            ? {
                action: "failed",
                progress: 100,
                error: "Predefined simulated failure",
              }
            : {
                action: "completed",
                progress: 100,
                result: {
                  simulated: true,
                  summary:
                    "Simulated planning, implementation, and verification completed.",
                  steps: 5,
                },
              };
        await save(journal); // Persist outcome before reporting: lost responses can be retried after restart.
      }
    }
    await report(journal.outcome);
    log(journal.outcome.action, { job_id: job.id });
    await rm(path!, { force: true });
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      log("lease_lost", { job_id: job.id });
      await rm(path!, { force: true });
      return false;
    }
    throw e;
  }
}
