// Opt-in: consumes the local ChatGPT/Codex allowance and runs the actual SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { handle } from "../src/lib/api";
import { generateKey, hashKey } from "../src/lib/keys";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "real Codex through HTTP API, PostgreSQL queue and separate worker",
  { skip: process.env.RUN_REAL_CODEX !== "1", timeout: 300000 },
  async () => {
    assert.equal(
      process.versions.node.split(".")[0],
      "24",
      "Run this test with Node 24",
    );
    const dir = await mkdtemp(join(tmpdir(), "conduit-real-http-"));
    // Reserve an ephemeral port for the disposable PostgreSQL process.
    const portServer = createServer();
    await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
    const port = (portServer.address() as any).port;
    await new Promise<void>((r) => portServer.close(() => r()));
    const password = randomBytes(24).toString("hex");
    const postgres = new EmbeddedPostgres({
      databaseDir: join(dir, "db"),
      port,
      user: "postgres",
      password,
      persistent: false,
      autoRehydrateSymlinks: true,
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {},
      onError: () => {},
    });
    let db: pg.Pool | undefined, worker: ChildProcess | undefined;
    let logs = "";
    let progressReports = 0;
    let interruptedAttempt: string | undefined;
    let restartedAttempt: string | undefined;
    const api = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (
          req.url?.endsWith("/report") &&
          JSON.parse(Buffer.concat(chunks).toString()).action === "progress" &&
          ++progressReports === 2
        ) {
          interruptedAttempt = JSON.parse(
            await readFile(
              join(dir, `worker-state/journal-${req.url!.split("/")[3]}.json`),
              "utf8",
            ),
          ).attempt_dir;
          res.writeHead(503);
          res.end("{}");
          return;
        }
        const response = await handle(
          new Request("http://localhost" + req.url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          }),
          db!,
        );
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(await response.text());
      } catch {
        res.writeHead(500);
        res.end("{}");
      }
    });
    async function stop() {
      if (!worker || worker.exitCode !== null || worker.signalCode) return;
      const exit = new Promise<void>((r) => worker!.once("exit", () => r()));
      worker.kill("SIGTERM");
      await exit;
      worker = undefined;
    }
    try {
      await postgres.initialise();
      await postgres.start();
      db = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password,
        database: "postgres",
      });
      for (const file of (await readdir("supabase/migrations")).sort())
        await db.query(
          await readFile(join("supabase/migrations", file), "utf8"),
        );
      const submitter = generateKey().token,
        workerKey = generateKey().token;
      for (const [role, token] of [
        ["submitter", submitter],
        ["worker", workerKey],
      ])
        await db.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at) VALUES($1,$2,$2,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
          [
            hashKey(token),
            role,
            token.slice(0, 17),
            role === "worker"
              ? ["jobs:claim", "jobs:update"]
              : ["jobs:create", "jobs:read"],
          ],
        );
      const credential = join(dir, "worker.json");
      await writeFile(
        credential,
        JSON.stringify({
          token: workerKey,
          role: "worker",
          principal: "worker",
        }),
        { mode: 0o600 },
      );
      await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(api.address() as any).port}`;
      async function request(path: string, body?: unknown) {
        const r = await fetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${submitter}`,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.ok(r.ok, `HTTP ${r.status}`);
        return r.json();
      }
      const start = (timeout = "120000") => {
        worker = spawn(
          process.execPath,
          ["--import", "tsx", "worker/index.ts"],
          {
            cwd: resolve("."),
            env: {
              NODE_ENV: "test",
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              CODEX_HOME: process.env.CODEX_HOME,
              CONDUIT_API_URL: origin,
              WORKER_KEY_FILE: credential,
              WORKER_STATE_DIR: join(dir, "worker-state"),
              CODEX_TIMEOUT_MS: timeout,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        worker.stdout!.on("data", (c) => {
          logs = (logs + c).slice(-10000);
        });
        worker.stderr!.on("data", (c) => {
          logs = (logs + c).slice(-10000);
        });
      };
      start();
      const results = [];
      for (const scenario of ["average", "failure", "timeout"]) {
        if (scenario === "timeout") {
          await stop();
          start("1000");
        }
        const instructions =
          scenario === "average"
            ? "Create and export an average(numbers: number[]) function. Return 0 for an empty array. Add unit tests covering empty arrays, positive values, and negative values."
            : scenario === "failure"
              ? "Create test/failure.test.mjs using node:test and node:assert/strict with one test containing assert.equal(1, 2). This is an intentional failure-handling experiment. Leave the test failing."
              : "Implement an extensive arithmetic parser with nesting, operators, errors, and exhaustive tests.";
        const created = (
          await request("/api/jobs", {
            title: scenario,
            task: "codex_task",
            project: "typescript-sandbox",
            instructions,
          })
        ).job;
        assert.ok(
          ["queued", "running"].includes(
            (
              await db.query(
                "SELECT status FROM orchestrator.jobs WHERE id=$1",
                [created.id],
              )
            ).rows[0].status,
          ),
        );
        if (scenario === "failure") {
          await pause(3500);
          restartedAttempt = JSON.parse(
            await readFile(
              join(dir, `worker-state/journal-${created.id}.json`),
              "utf8",
            ),
          ).attempt_dir;
          const crashed = worker!;
          const exited = new Promise<void>((r) =>
            crashed.once("exit", () => r()),
          );
          crashed.kill("SIGKILL");
          await exited;
          worker = undefined;
          await pause(1500); // supervisor disconnect cleanup completes before manual stale-lock recovery
          await rm(join(dir, "worker-state/lock"), { force: true });
          start();
        }
        let final: any;
        for (let i = 0; i < 100; i++) {
          const { job } = await request("/api/jobs/" + created.id);
          if (["completed", "failed"].includes(job.status)) {
            final = job;
            break;
          }
          await pause(1500);
        }
        assert.ok(final, `No final result: ${logs}`);
        assert.ok(final.worker_id);
        assert.equal(final.attempt_count, 1);
        assert.ok(final.result.attempt_id);
        if (scenario === "average") {
          assert.equal(final.status, "completed", JSON.stringify(final.result));
          assert.equal(final.result.verification.status, "passed");
          assert.ok(final.result.changed_files.includes("src/index.ts"));
          assert.ok(final.result.thread_id);
          assert.match(
            await readFile(
              join(final.result.workspace, "src/index.ts"),
              "utf8",
            ),
            /average/,
          );
          assert.ok(interruptedAttempt);
          assert.notEqual(
            final.result.workspace,
            join(interruptedAttempt!, "project"),
          );
          await assert.rejects(
            readFile(join(interruptedAttempt!, "auth/auth.json")),
          );
          assert.match(logs, /"event":"retry"/);
          assert.deepEqual(
            final.result.verification.checks.map((c: any) => c.exit_code),
            [0, 0],
          );
        } else if (scenario === "failure") {
          assert.equal(final.status, "failed");
          assert.equal(final.result.execution.status, "completed");
          assert.equal(final.result.verification.status, "failed");
          assert.equal(final.result.verification.checks[1].exit_code, 1);
          assert.ok(restartedAttempt);
          assert.notEqual(
            final.result.workspace,
            join(restartedAttempt!, "project"),
          );
          await assert.rejects(
            readFile(join(restartedAttempt!, "auth/auth.json")),
          );
        } else {
          assert.equal(final.status, "failed");
          assert.match(final.result.execution.error, /timed out|interrupted/);
        }
        const stored: unknown = (
          await db.query("SELECT result FROM orchestrator.jobs WHERE id=$1", [
            created.id,
          ])
        ).rows[0].result;
        assert.deepEqual(stored, final.result);
        assert.equal(final.claim_token, undefined);
        results.push(final);
        await assert.rejects(
          readFile(join(final.result.workspace, "../auth/auth.json")),
        );
      }
      assert.equal(new Set(results.map((r) => r.result.workspace)).size, 3);
      assert.ok(!logs.includes(workerKey));
      await mkdir("output", { recursive: true });
      await writeFile(
        "output/phase3-real-local.json",
        JSON.stringify(results, null, 2),
        { mode: 0o600 },
      );
    } finally {
      await stop();
      await new Promise<void>((r) => api.close(() => r()));
      await db?.end();
      await postgres.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
