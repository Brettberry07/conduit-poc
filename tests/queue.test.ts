import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { health, authCheck } from "../src/lib/checks";
import { handle } from "../src/lib/api";
import { generateKey, hashKey } from "../src/lib/keys";
import { ApiError, cycle, type Call } from "../worker/runner";

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
test(
  "isolated PostgreSQL queue and worker integration",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "conduit-test-"));
    const port = await freePort();
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
    const connections = new Set<pg.PoolClient>();
    const track = (pool: pg.Pool) =>
      pool.on("connect", (client) => {
        connections.add(client);
        client.once("end", () => connections.delete(client));
      });
    let db: pg.Pool | undefined;
    let runtime: pg.Pool | undefined;
    try {
      await postgres.initialise();
      await postgres.start();
      db = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password,
        database: "postgres",
        max: 12,
      });
      for (const file of (await readdir("supabase/migrations")).sort())
        await db.query(
          await readFile(join("supabase/migrations", file), "utf8"),
        );
      track(db);
      const pool = db;
      await pool.query(
        "CREATE ROLE conduit_test_runtime LOGIN PASSWORD 'test-only-password' INHERIT",
      );
      await pool.query("GRANT conduit_api TO conduit_test_runtime");
      runtime = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "conduit_test_runtime",
        password: "test-only-password",
        database: "postgres",
        max: 12,
      });
      track(runtime);
      const runtimeDb = runtime;
      const tokens = {
        submitter: generateKey().token,
        other: generateKey().token,
        worker: generateKey().token,
        worker2: generateKey().token,
        expired: generateKey().token,
        revoked: generateKey().token,
        readOnly: generateKey().token,
        claimOnly: generateKey().token,
        updateOnly: generateKey().token,
      };
      for (const [name, token] of Object.entries(tokens))
        await pool.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,expires_at,revoked_at,name,key_prefix,scopes) VALUES($1,$2,$3,clock_timestamp()+$4::interval,$5,$2,$6,$7)`,
          [
            hashKey(token),
            name,
            ["worker", "worker2", "claimOnly", "updateOnly"].includes(name)
              ? "worker"
              : "submitter",
            name === "expired" ? "-1 hour" : "1 hour",
            name === "revoked" ? new Date() : null,
            token.slice(0, 17),
            name === "readOnly"
              ? ["jobs:read"]
              : name === "claimOnly"
                ? ["jobs:claim"]
                : name === "updateOnly"
                  ? ["jobs:update"]
                  : name.startsWith("worker")
                    ? ["jobs:claim", "jobs:update"]
                    : ["jobs:create", "jobs:read"],
          ],
        );
      async function req(
        path: string,
        role: keyof typeof tokens | "none" = "submitter",
        method = "GET",
        body?: unknown,
        requestId: string = randomUUID(),
      ) {
        return handle(
          new Request(`http://localhost/api${path}`, {
            method,
            headers: {
              ...(role === "none"
                ? {}
                : { Authorization: `Bearer ${tokens[role]}` }),
              "Content-Type": "application/json",
              "Idempotency-Key": requestId,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          runtimeDb,
        );
      }
      async function create(task = "simulate-development") {
        const r = await req("/jobs", "submitter", "POST", {
          title: "Queue test",
          task,
        });
        assert.equal(r.status, 201);
        return (await r.json()).job;
      }
      const callFor =
        (role: "worker" | "worker2"): Call =>
        async (path, body) => {
          const r = await req(path.replace("/api", ""), role, "POST", body);
          if (!r.ok) throw new ApiError(r.status);
          return r.json();
        };
      const worker = callFor("worker"),
        worker2 = callFor("worker2");
      const reset = () =>
        pool.query("TRUNCATE orchestrator.jobs,orchestrator.workers CASCADE");
      await t.test(
        "authentication rejects missing, invalid, expired, revoked credentials",
        async () => {
          for (const role of ["none", "expired", "revoked"] as const)
            assert.equal((await req("/jobs", role)).status, 401);
          const invalid = await handle(
            new Request("http://localhost/api/jobs", {
              headers: { Authorization: `Bearer cnd_live_${"a".repeat(43)}` },
            }),
            runtimeDb,
          );
          assert.equal(invalid.status, 401);
        },
      );
      await t.test(
        "health checks queue readiness without authentication or job data",
        async () => {
          const response = await health(() => runtimeDb);
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            status: "ok",
            service: "Conduit POC",
            database: "ok",
          });
          assert.equal(response.headers.get("cache-control"), "no-store");
        },
      );
      await t.test(
        "auth-check validates credentials and requires both Instinct scopes",
        async () => {
          for (const name of [
            "submitter",
            "worker",
            "readOnly",
            "expired",
            "revoked",
            "none",
          ] as const) {
            const response = await authCheck(
              new Request("http://localhost/auth-check", {
                headers:
                  name === "none"
                    ? {}
                    : { Authorization: `Bearer ${tokens[name]}` },
              }),
              () => runtimeDb,
            );
            assert.equal(
              response.status,
              name === "submitter"
                ? 200
                : ["worker", "readOnly"].includes(name)
                  ? 403
                  : 401,
            );
            const body = await response.json();
            assert.equal(body.instinct_access, name === "submitter");
            assert.equal(
              body.authenticated,
              ["submitter", "worker", "readOnly"].includes(name),
            );
            assert.ok(
              !JSON.stringify(body).includes(
                name === "none" ? "cnd_live_" : tokens[name],
              ),
            );
          }
          const invalid = await authCheck(
            new Request("http://localhost/auth-check", {
              headers: { Authorization: "Bearer " + generateKey().token },
            }),
            () => runtimeDb,
          );
          assert.equal(invalid.status, 401);
        },
      );
      await t.test(
        "scopes are enforced per operation and valid keys update last-used",
        async () => {
          assert.equal((await req("/jobs", "readOnly")).status, 200);
          assert.equal(
            (await req("/jobs", "readOnly", "POST", { title: "Denied" }))
              .status,
            403,
          );
          assert.equal((await req("/claim", "claimOnly", "POST")).status, 200);
          assert.equal(
            (await req("/heartbeat", "claimOnly", "POST")).status,
            403,
          );
          assert.equal((await req("/claim", "updateOnly", "POST")).status, 403);
          assert.equal(
            (await req("/heartbeat", "updateOnly", "POST")).status,
            200,
          );
          const {
            rows: [key],
          } = await pool.query(
            "SELECT last_used_at FROM orchestrator.api_keys WHERE key_hash=$1",
            [hashKey(tokens.readOnly)],
          );
          assert.ok(key.last_used_at);
          const {
            rows: [unused],
          } = await pool.query(
            "SELECT last_used_at FROM orchestrator.api_keys WHERE key_hash=$1",
            [hashKey(tokens.expired)],
          );
          assert.equal(unused.last_used_at, null);
        },
      );
      await t.test(
        "runtime validates keys but cannot read or manage them",
        async () => {
          for (const sql of [
            "SELECT * FROM orchestrator.api_keys",
            "UPDATE orchestrator.api_keys SET revoked_at=NULL",
            "INSERT INTO orchestrator.api_keys(key_hash) VALUES('x')",
            "DELETE FROM orchestrator.api_keys",
          ])
            await assert.rejects(runtimeDb.query(sql), /permission denied/);
          await pool.query("CREATE ROLE anon NOLOGIN");
          await pool.query("CREATE ROLE authenticated NOLOGIN");
          for (const role of ["anon", "authenticated"]) {
            const c = await pool.connect();
            try {
              await c.query(`SET ROLE ${role}`);
              await assert.rejects(
                c.query("SELECT * FROM orchestrator.api_keys"),
                /permission denied/,
              );
              await assert.rejects(
                c.query("SELECT * FROM orchestrator.authenticate_api_key($1)", [
                  hashKey(tokens.submitter),
                ]),
                /permission denied/,
              );
            } finally {
              await c.query("RESET ROLE");
              c.release();
            }
          }
        },
      );
      await t.test(
        "key administrator can manage credentials but cannot read jobs or validate hashes",
        async () => {
          const connection = await pool.connect();
          try {
            await connection.query("SET ROLE conduit_key_admin");
            assert.ok(
              (
                await connection.query(
                  "SELECT id,name,key_prefix FROM orchestrator.api_keys",
                )
              ).rowCount,
            );
            await assert.rejects(
              connection.query("SELECT * FROM orchestrator.jobs"),
              /permission denied/,
            );
            await assert.rejects(
              connection.query(
                "SELECT * FROM orchestrator.authenticate_api_key($1)",
                [hashKey(tokens.submitter)],
              ),
              /permission denied/,
            );
          } finally {
            await connection.query("RESET ROLE");
            connection.release();
          }
        },
      );
      await t.test("separate permissions and owner isolation", async () => {
        assert.equal((await req("/claim", "submitter", "POST")).status, 403);
        assert.equal(
          (await req("/jobs", "worker", "POST", { title: "No" })).status,
          403,
        );
        const job = await create();
        assert.equal((await req(`/jobs/${job.id}`, "other")).status, 404);
        assert.deepEqual((await (await req("/jobs", "other")).json()).jobs, []);
        assert.equal((await req(`/jobs/${job.id}`, "worker")).status, 403);
      });
      await t.test(
        "creation validates predefined tasks and is idempotent",
        async () => {
          await reset();
          const id = randomUUID();
          const body = { title: "Safe job", description: "Test" };
          const a = await (
            await req("/jobs", "submitter", "POST", body, id)
          ).json();
          const b = await (
            await req("/jobs", "submitter", "POST", body, id)
          ).json();
          assert.equal(a.job.id, b.job.id);
          assert.equal(a.job.status, "queued");
          assert.ok(a.job.created_at);
          assert.equal(a.job.attempt_count, 0);
          assert.equal(
            (
              await req(
                "/jobs",
                "submitter",
                "POST",
                { ...body, title: "Different" },
                id,
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await req("/jobs", "submitter", "POST", {
                title: "Bad",
                task: "shell",
                command: "touch /tmp/no",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await req(
                "/jobs",
                "submitter",
                "POST",
                { title: "Bad" },
                "bad-id",
              )
            ).status,
            400,
          );
          assert.equal(
            (
              await req("/jobs", "submitter", "POST", {
                title: "x".repeat(40000),
              })
            ).status,
            400,
          );
          assert.equal((await req("/jobs?limit=100000")).status, 400);
        },
      );
      await t.test(
        "Codex input validation, idempotency, failed verification results and fencing",
        async () => {
          await reset();
          const input = {
            title: "Average",
            task: "codex_task",
            project: "typescript-sandbox",
            instructions: "Implement average",
            acceptance_criteria: "Tests pass",
          };
          const requestId = randomUUID();
          for (const invalid of [
            { ...input, project: "/tmp/arbitrary" },
            { ...input, instructions: "" },
            { ...input, command: "echo bad" },
            { ...input, task: "simulate-development" },
          ])
            assert.equal(
              (await req("/jobs", "submitter", "POST", invalid)).status,
              400,
            );
          const submitted = await req(
            "/jobs",
            "submitter",
            "POST",
            input,
            requestId,
          );
          assert.equal(submitted.status, 201);
          const created = (await submitted.json()).job;
          assert.equal(created.instructions, input.instructions);
          assert.equal(
            (
              await req(
                "/jobs",
                "submitter",
                "POST",
                { ...input, instructions: "Changed" },
                requestId,
              )
            ).status,
            409,
          );
          const { job } = await worker("/api/claim", {});
          assert.equal(job.id, created.id);
          assert.equal(job.project, "typescript-sandbox");
          const outcome = {
            claim_token: job.claim_token,
            action: "failed",
            progress: 100,
            error: "Verification failed",
            result: {
              execution: { status: "completed" },
              verification: { status: "failed" },
              changed_files: ["src/index.ts"],
            },
          };
          await worker(`/api/jobs/${job.id}/report`, outcome);
          await worker(`/api/jobs/${job.id}/report`, {
            ...outcome,
            result: { overwrite: true },
          });
          const final = (await (await req(`/jobs/${job.id}`)).json()).job;
          assert.equal(final.status, "failed");
          assert.deepEqual(final.result, outcome.result);
          assert.equal(final.claim_token, undefined);
        },
      );
      await t.test("12 concurrent claims yield exactly one owner", async () => {
        await reset();
        await create();
        const claims = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            (i % 2 ? worker : worker2)("/api/claim", {}),
          ),
        );
        const claimed = claims.filter((r) => r.job);
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].job.attempt_count, 1);
        assert.ok(claimed[0].job.claim_token);
        assert.ok(claimed[0].job.lease_expires_at);
        const listed = await (await req("/jobs")).json();
        assert.equal(listed.jobs[0].claim_token, undefined);
      });
      await t.test(
        "SKIP LOCKED claims another job while oldest is locked",
        async () => {
          await reset();
          const first = await create();
          await create();
          const connection = await pool.connect();
          try {
            await connection.query("BEGIN");
            await connection.query(
              "SELECT id FROM orchestrator.jobs WHERE id=$1 FOR UPDATE",
              [first.id],
            );
            const { job } = await worker("/api/claim", {});
            assert.ok(job);
            assert.notEqual(job.id, first.id);
          } finally {
            await connection.query("ROLLBACK");
            connection.release();
          }
        },
      );
      await t.test(
        "progress, completion, failure and duplicate terminal reports",
        async () => {
          await reset();
          await create();
          const { job } = await worker("/api/claim", {});
          const path = `/api/jobs/${job.id}/report`;
          await assert.rejects(
            worker2(path, {
              claim_token: job.claim_token,
              action: "completed",
              result: {},
            }),
            (e) => e instanceof ApiError && e.status === 409,
          );
          const progress = await worker(path, {
            claim_token: job.claim_token,
            action: "progress",
            progress: 60,
          });
          assert.equal(progress.job.progress, 60);
          const body = {
            claim_token: job.claim_token,
            action: "completed",
            progress: 100,
            result: { simulated: true },
          };
          const a = await worker(path, body);
          const b = await worker(path, { ...body, result: { changed: true } });
          assert.equal(a.job.completed_at, b.job.completed_at);
          assert.deepEqual(b.job.result, { simulated: true });
          assert.equal(b.job.lease_expires_at, null);
          await assert.rejects(
            worker(path, {
              claim_token: job.claim_token,
              action: "failed",
              error: "late",
            }),
            (e) => e instanceof ApiError && e.status === 409,
          );
          await create("simulate-failure");
          const failed = await worker("/api/claim", {});
          const f = await worker(`/api/jobs/${failed.job.id}/report`, {
            claim_token: failed.job.claim_token,
            action: "failed",
            error: "Simulated",
          });
          assert.equal(f.job.status, "failed");
        },
      );
      await t.test(
        "expired claim is fenced; recovery issues a new token",
        async () => {
          await reset();
          await create();
          const old = (await worker("/api/claim", {})).job;
          await pool.query(
            `UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [old.id],
          );
          await assert.rejects(
            worker(`/api/jobs/${old.id}/report`, {
              claim_token: old.claim_token,
              action: "progress",
            }),
            (e) => e instanceof ApiError && e.status === 409,
          );
          const fresh = (await worker2("/api/claim", {})).job;
          assert.equal(fresh.id, old.id);
          assert.equal(fresh.attempt_count, 2);
          assert.notEqual(fresh.claim_token, old.claim_token);
          await assert.rejects(
            worker(`/api/jobs/${old.id}/report`, {
              claim_token: old.claim_token,
              action: "completed",
              result: {},
            }),
            (e) => e instanceof ApiError && e.status === 409,
          );
        },
      );
      await t.test("abandoned jobs fail after three attempts", async () => {
        await reset();
        const j = await create();
        for (let i = 1; i <= 3; i++) {
          assert.equal((await worker("/api/claim", {})).job.attempt_count, i);
          await pool.query(
            `UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [j.id],
          );
        }
        assert.equal((await worker("/api/claim", {})).job, null);
        const job = (await (await req(`/jobs/${j.id}`)).json()).job;
        assert.equal(job.status, "failed");
        assert.ok(job.completed_at);
      });
      await t.test(
        "worker resumes journal after network failure and restart",
        async () => {
          await reset();
          await create();
          const state = join(dir, "worker-restart");
          let calls = 0;
          const flaky: Call = async (path, body) => {
            if (path.endsWith("/report") && ++calls === 2)
              throw Error("disconnected");
            return worker(path, body);
          };
          await assert.rejects(cycle(flaky, state, async () => {}));
          const saved = JSON.parse(
            await readFile(join(state, "journal.json"), "utf8"),
          );
          assert.ok(saved.job.claim_token);
          await cycle(worker, state, async () => {});
          await assert.rejects(readFile(join(state, "journal.json")));
          const jobs = (await (await req("/jobs")).json()).jobs;
          assert.equal(jobs[0].status, "completed");
          assert.equal(jobs[0].attempt_count, 1);
        },
      );
      await t.test(
        "worker safely retries persisted outcome after lost completion response",
        async () => {
          await reset();
          await create();
          const state = join(dir, "lost-response");
          let lost = false;
          const flaky: Call = async (path, body) => {
            const result = await worker(path, body);
            if ((body as any)?.action === "completed" && !lost) {
              lost = true;
              throw Error("lost response");
            }
            return result;
          };
          await assert.rejects(cycle(flaky, state, async () => {}));
          let steps = 0;
          await cycle(worker, state, async () => {
            steps++;
          });
          assert.equal(steps, 0);
          assert.equal(
            (await (await req("/jobs")).json()).jobs[0].status,
            "completed",
          );
        },
      );
      await t.test(
        "restarted stale worker drops journal without executing task",
        async () => {
          await reset();
          await create();
          const state = join(dir, "stale");
          await assert.rejects(
            cycle(
              async (path, body) => {
                if (path.endsWith("/report")) throw Error("offline");
                return worker(path, body);
              },
              state,
              async () => {},
            ),
          );
          await pool.query(
            `UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second'`,
          );
          await worker2("/api/claim", {});
          let steps = 0;
          await cycle(worker, state, async () => {
            steps++;
          });
          assert.equal(steps, 0);
          await assert.rejects(readFile(join(state, "journal.json")));
        },
      );
      await t.test(
        "worker records simulated failure and availability",
        async () => {
          await reset();
          await create("simulate-failure");
          await cycle(worker, join(dir, "failure"), async () => {});
          assert.equal(
            (await (await req("/jobs")).json()).jobs[0].status,
            "failed",
          );
          const workers = (await (await req("/workers")).json()).workers;
          assert.equal(workers[0].available, true);
          assert.equal(workers[0].busy, false);
          await pool.query(
            `UPDATE orchestrator.workers SET last_seen_at=clock_timestamp()-interval '1 minute'`,
          );
          assert.equal(
            (await (await req("/workers")).json()).workers[0].available,
            false,
          );
        },
      );
      await t.test(
        "private tables have RLS and no public schema permissions",
        async () => {
          const { rows } = await pool.query(
            `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='orchestrator' AND c.relkind='r'`,
          );
          assert.equal(rows.length, 7);
          assert.ok(rows.every((r) => r.relrowsecurity));
          await pool.query("CREATE ROLE poc_untrusted NOLOGIN");
          await pool.query("GRANT poc_untrusted TO postgres");
          const connection = await pool.connect();
          try {
            await connection.query("SET ROLE poc_untrusted");
            await assert.rejects(
              connection.query("SELECT * FROM orchestrator.jobs"),
              /permission denied/,
            );
          } finally {
            await connection.query("RESET ROLE");
            connection.release();
          }
        },
      );
    } finally {
      // pg.Pool.end resolves before every socket has emitted end; let clients close before stopping PostgreSQL.
      const closed = [...connections].map(
        (client) => new Promise<void>((done) => client.once("end", done)),
      );
      await runtime?.end();
      await db?.end();
      await Promise.all(closed);
      await postgres.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
