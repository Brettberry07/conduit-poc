import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { maxAgents } from "../worker/supervisor";
import { supervise } from "../worker/supervisor";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function eventually(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await delay(2);
  }
  assert.fail("Worker did not reach the expected state");
}

test("four agents execute distinct jobs and start the fifth only when a slot frees", async () => {
  const stateDir = await mkdtemp(join(process.cwd(), ".worker-supervisor-"));
  let stop = false;
  let claimed = 0;
  let peak = 0;
  let reconciliations = 0;
  const active = new Set<string>();
  const completed = new Set<string>();
  const gates = new Map<string, () => void>();
  const worker = supervise({
    stateDir,
    limit: 4,
    stopping: () => stop,
    wait: async () => {
      await delay(1);
    },
    reconcile: async () => {
      reconciliations++;
    },
    call: async (path, body: any) => {
      if (path === "/api/heartbeat") return {};
      if (path === "/api/claim") {
        if (claimed === 5) return { job: null };
        const id = String(++claimed);
        assert.ok(!active.has(id));
        active.add(id);
        peak = Math.max(peak, active.size);
        assert.ok(active.size <= 4);
        return {
          job: { id, claim_token: `token-${id}`, task: "simulate-development" },
        };
      }
      const id = path.split("/")[3];
      assert.equal(body.claim_token, `token-${id}`);
      if (body.action === "progress" && body.progress === 0)
        await new Promise<void>((resolve) => gates.set(id, resolve));
      if (body.action === "completed") {
        assert.ok(!completed.has(id));
        completed.add(id);
        active.delete(id);
        if (completed.size === 5) stop = true;
      }
      return {};
    },
  });
  try {
    await eventually(() => gates.size === 4);
    assert.equal(claimed, 4);
    assert.equal(active.size, 4);
    gates.get("1")!();
    await eventually(() => gates.has("5"));
    assert.deepEqual([...completed], ["1"]);
    assert.equal(active.size, 4);
    for (const [id, release] of gates) if (id !== "1") release();
    await worker;
    assert.equal(peak, 4);
    assert.equal(completed.size, 5);
    assert.equal(reconciliations, 1);
    assert.deepEqual(await readdir(stateDir), []);
  } finally {
    stop = true;
    for (const release of gates.values()) release();
    await worker;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an agent retries its owned job and shutdown preserves its journal without another claim", async () => {
  const stateDir = await mkdtemp(join(process.cwd(), ".worker-supervisor-"));
  let stop = false;
  let claims = 0;
  let reports = 0;
  try {
    await supervise({
      stateDir,
      limit: 1,
      stopping: () => stop,
      wait: async () => {
        await delay(1);
      },
      reconcile: async () => {},
      call: async (path, body: any) => {
        if (path === "/api/heartbeat") return {};
        if (path === "/api/claim") {
          claims++;
          return {
            job: {
              id: "owned",
              claim_token: "fenced",
              task: "simulate-development",
            },
          };
        }
        assert.equal(path, "/api/jobs/owned/report");
        assert.equal(body.action, "progress");
        assert.equal(body.claim_token, "fenced");
        reports++;
        if (reports === 1) throw Error("temporary network failure");
        stop = true;
        return {};
      },
    });
    assert.equal(claims, 1);
    assert.equal(reports, 2);
    assert.deepEqual(await readdir(stateDir), ["journal-owned.json"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("worker agent limit defaults to four and accepts one through four", () => {
  assert.equal(maxAgents(undefined), 4);
  for (const limit of [1, 2, 3, 4])
    assert.equal(maxAgents(String(limit)), limit);
});

test("worker agent limit rejects invalid values without clamping", () => {
  for (const value of [
    "",
    "zero",
    "NaN",
    "Infinity",
    "0",
    "-1",
    "5",
    "1.5",
    "2.0",
    " 2",
    "2 ",
    "1e0",
  ])
    assert.throws(
      () => maxAgents(value),
      /CONDUIT_MAX_AGENTS must be an integer from 1 to 4/,
    );
});

test("worker startup rejects an invalid Codex timeout before loading credentials", () => {
  const worker = spawnSync(
    process.execPath,
    ["--import", "tsx", "worker/index.ts"],
    {
      env: {
        ...process.env,
        CODEX_TIMEOUT_MS: "1800001",
        CONDUIT_MAX_AGENTS: "1",
        WORKER_KEY_FILE: "",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(worker.error);
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /CODEX_TIMEOUT_MS must be 1000\.\.1800000/);
});
