import { readFile, mkdir, open, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ApiError, cycle, log } from "./runner";
import { apiOrigin, workerClient } from "./client";
const base = apiOrigin(
  process.env.CONDUIT_API_URL ??
    process.env.ORCHESTRATOR_URL ??
    "http://127.0.0.1:3000",
);
if (!process.env.WORKER_KEY_FILE)
  throw Error("Set WORKER_KEY_FILE to the worker credential JSON path");
let credential: { token: string; role: string; principal: string };
try {
  credential = JSON.parse(await readFile(process.env.WORKER_KEY_FILE, "utf8"));
} catch {
  throw Error("Unable to read worker credential JSON file");
}
if (
  credential.role !== "worker" ||
  !/^cnd_live_[A-Za-z0-9_-]{43}$/.test(credential.token) ||
  !/^[A-Za-z0-9_-]{1,80}$/.test(credential.principal)
)
  throw Error("A valid worker credential file is required");
const dir = resolve(
  process.env.WORKER_STATE_DIR ?? join(".worker", credential.principal),
);
await mkdir(dir, { recursive: true, mode: 0o700 });
// Exclusive lock: a stale lock requires manual verification, never unsafe automatic stealing.
const lock = await open(join(dir, "lock"), "wx", 0o600).catch(() => {
  throw Error(
    `Worker state is locked. Verify no worker uses ${dir}, then remove its lock file.`,
  );
});
await lock.writeFile(String(process.pid));
await lock.close();
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const call = workerClient(base, credential.token);
log("started", { worker_id: credential.principal });
let backoff = 1000;
let lastReconciliation = 0;
try {
  // Bind persistent recovery state to its API origin; never send old claim tokens to another host.
  const binding = join(dir, "origin");
  try {
    await open(binding, "wx", 0o600).then(async (file) => {
      try {
        await file.writeFile(base.origin);
      } finally {
        await file.close();
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(binding, "utf8")) !== base.origin)
      throw Error(
        "Worker state belongs to another API origin. Use a separate WORKER_STATE_DIR.",
      );
  }
  while (!stop) {
    try {
      if (Date.now() - lastReconciliation > 30000) {
        const { reconcileDevelopment } = await import("./development/run");
        try {
          await reconcileDevelopment(call);
        } catch {
          log("github_reconciliation_pending");
        }
        lastReconciliation = Date.now();
      }
      await cycle(call, dir, wait, () => stop);
      backoff = 1000;
      if (!stop) await wait(2000);
    } catch (e) {
      log("retry", {
        error:
          e instanceof ApiError ? e.message : "Network or local state error",
        delay_ms: backoff,
      });
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        process.exitCode = 1;
        break;
      }
      if (!stop) await wait(backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
  }
} finally {
  await rm(join(dir, "lock"), { force: true });
  log("stopped");
}
