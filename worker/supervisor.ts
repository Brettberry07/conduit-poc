import { ApiError, cycle, log, recoverJournals, type Call } from "./runner";

export function maxAgents(value: string | undefined): number {
  if (value === undefined) return 4;
  if (!/^[1-4]$/.test(value))
    throw Error("CONDUIT_MAX_AGENTS must be an integer from 1 to 4");
  return Number(value);
}

export async function supervise(options: {
  call: Call;
  stateDir: string;
  limit: number;
  wait: (ms: number) => Promise<void>;
  stopping: () => boolean;
  reconcile: () => Promise<void>;
}) {
  const { call, stateDir, limit, wait, reconcile } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 4)
    throw Error("CONDUIT_MAX_AGENTS must be an integer from 1 to 4");
  // Validate all recovery files before any agent can claim fresh work.
  const recovered = await recoverJournals(stateDir);
  let fatal: unknown;
  const stopping = () => options.stopping() || fatal !== undefined;
  async function agent() {
    let path: string | null = null;
    let backoff = 1000;
    while (!stopping()) {
      path ??= recovered.shift() ?? null;
      try {
        const completed = await cycle(
          call,
          stateDir,
          wait,
          stopping,
          path,
          (claimedPath) => {
            path = claimedPath;
          },
        );
        path = null;
        backoff = 1000;
        if (!completed && !stopping()) await wait(2000);
      } catch (error) {
        if (
          (error instanceof ApiError &&
            (error.status === 401 || error.status === 403)) ||
          (error instanceof Error &&
            error.message.includes("refusing to discard recovery state"))
        ) {
          fatal = error;
          return;
        }
        log("retry", {
          error:
            error instanceof ApiError
              ? error.message
              : "Network or local state error",
          delay_ms: backoff,
        });
        if (!stopping()) await wait(backoff);
        backoff = Math.min(backoff * 2, 10000);
      }
    }
  }
  async function reconciliation() {
    let lastReconciliation = 0;
    while (!stopping()) {
      if (Date.now() - lastReconciliation > 30000) {
        try {
          await reconcile();
        } catch {
          log("github_reconciliation_pending");
        }
        lastReconciliation = Date.now();
      }
      if (!stopping()) await wait(2000);
    }
  }
  await Promise.all([
    reconciliation(),
    ...Array.from({ length: limit }, agent),
  ]);
  if (fatal !== undefined) throw fatal;
}
