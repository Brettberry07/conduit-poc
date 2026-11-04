import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
export type ClaimedJob = {
  id: string;
  claim_token: string;
  task: "simulate-development" | "simulate-failure";
};
type Journal = {
  job: ClaimedJob;
  outcome?: {
    action: "completed" | "failed";
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
export async function cycle(
  call: Call,
  stateDir: string,
  wait: (ms: number) => Promise<void>,
  stopping: () => boolean = () => false,
) {
  await call("/api/heartbeat", {});
  const path = join(stateDir, "journal.json");
  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error("Cannot read journal; refusing to discard recovery state");
    const { job } = await call("/api/claim", {});
    if (!job) return false;
    journal = { job };
    await save(journal);
    log("claimed", { job_id: job.id });
  }
  async function save(value: Journal) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  const { job } = journal;
  const report = (value: unknown) =>
    call(`/api/jobs/${job.id}/report`, {
      claim_token: job.claim_token,
      ...(value as object),
    });
  try {
    if (!journal.outcome) {
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
    await report(journal.outcome);
    log(journal.outcome.action, { job_id: job.id });
    await rm(path, { force: true });
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      log("lease_lost", { job_id: job.id });
      await rm(path, { force: true });
      return false;
    }
    throw e;
  }
}
