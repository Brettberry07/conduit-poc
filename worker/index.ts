import { readFile, mkdir, open, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ApiError, cycle, log } from "./runner";
const base = new URL(process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3000");
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw Error("Use a plain API origin");
if (
  base.protocol !== "https:" &&
  !(
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
)
  throw Error("HTTPS required except loopback");
if (!process.env.WORKER_KEY_FILE)
  throw Error("Set WORKER_KEY_FILE to the worker credential JSON path");
const credential = JSON.parse(
  await readFile(process.env.WORKER_KEY_FILE, "utf8"),
);
if (credential.role !== "worker") throw Error("Worker credential required");
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
const call = async (path: string, body?: unknown) => {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
};
log("started", { worker_id: credential.principal });
let backoff = 1000;
try {
  while (!stop) {
    try {
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
