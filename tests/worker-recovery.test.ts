import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cycle, recoverJournals, type Call } from "../worker/runner";
import { supervise } from "../worker/supervisor";

test("startup resumes five unfinished journals including legacy within the agent limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-pending-"));
  try {
    for (let i = 0; i < 5; i++)
      await writeFile(
        join(dir, i === 0 ? "journal.json" : `journal-job-${i}.json`),
        JSON.stringify({
          job: {
            id: `job-${i}`,
            claim_token: `token-${i}`,
            task: "simulate-development",
          },
        }),
      );
    const active = new Set<string>();
    const finished = new Set<string>();
    const claimCounts: number[] = [];
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call: Call = async (path, body) => {
      if (path === "/api/heartbeat") return {};
      if (path === "/api/claim") {
        claimCounts.push(active.size + finished.size);
        return { job: null };
      }
      const id = path.split("/")[3];
      const value = body as { action: string; progress: number };
      if (value.action === "progress" && value.progress === 0) {
        assert.ok(!active.has(id) && !finished.has(id));
        active.add(id);
        maximum = Math.max(maximum, active.size);
        if (active.size === 2) release();
      } else if (value.action === "completed") {
        assert.ok(active.delete(id));
        assert.ok(!finished.has(id));
        finished.add(id);
      }
      return {};
    };
    await supervise({
      call,
      stateDir: dir,
      limit: 2,
      wait: async (ms) => {
        if (ms === 1000) await gate;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      stopping: () => finished.size === 5,
      reconcile: async () => {},
    });
    assert.equal(maximum, 2);
    assert.equal(finished.size, 5);
    // The final recovered job can be assigned but still awaiting its first file read.
    assert.ok(claimCounts.every((count) => count >= 4));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent agents persist distinct jobs and recover legacy and per-job outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-recovery-"));
  try {
    const jobs = Array.from({ length: 3 }, (_, i) => ({
      id: `job-${i}`,
      claim_token: `token-${i}`,
      task: "simulate-development",
    }));
    const claimed: string[] = [];
    const completed = new Set<string>();
    let loseResponses = true;
    let progress = 0;
    const call: Call = async (path, body) => {
      if (path === "/api/heartbeat") return {};
      if (path === "/api/claim") {
        const job = jobs.shift();
        if (job) claimed.push(job.id);
        return { job };
      }
      const value = body as { action: string; claim_token: string };
      const id = path.split("/")[3];
      assert.equal(value.claim_token, `token-${id.slice(4)}`);
      if (value.action === "progress") progress++;
      else {
        completed.add(id); // API terminal reports are idempotent after a lost response.
        if (loseResponses) throw Error("lost terminal response");
      }
      return {};
    };
    const initial = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        cycle(
          call,
          dir,
          async () => {},
          () => false,
          null,
        ),
      ),
    );
    assert.ok(initial.every((result) => result.status === "rejected"));
    assert.equal(new Set(claimed).size, 3);
    assert.equal(progress, 15);
    const files = await recoverJournals(dir);
    assert.equal(files.length, 3);
    const legacy = join(dir, "journal.json");
    await writeFile(legacy, await readFile(files[0]));
    await rm(files[0]);
    const recovered = await recoverJournals(dir);
    assert.ok(recovered.includes(legacy));
    loseResponses = false;
    await Promise.all(
      recovered.map((path) =>
        cycle(
          call,
          dir,
          async () => {
            throw Error("must not execute persisted outcome");
          },
          () => false,
          path,
        ),
      ),
    );
    assert.equal(progress, 15);
    assert.equal(claimed.length, 3);
    assert.equal(completed.size, 3);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all recovery journals are validated before claims and unreadable state is retained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-corrupt-"));
  try {
    await writeFile(join(dir, "journal-broken.json"), "{corrupt");
    await assert.rejects(
      recoverJournals(dir),
      /Cannot read journal; refusing to discard recovery state/,
    );
    await assert.rejects(
      supervise({
        stateDir: dir,
        limit: 4,
        stopping: () => false,
        call: async () =>
          assert.fail("must validate before contacting the API"),
        wait: async () => assert.fail("must refuse rather than retry"),
        reconcile: async () => assert.fail("must validate before reconciling"),
      }),
      /Cannot read journal; refusing to discard recovery state/,
    );
    assert.equal(
      await readFile(join(dir, "journal-broken.json"), "utf8"),
      "{corrupt",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
