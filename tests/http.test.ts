import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as httpServer, type Server } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { applyMigrations } from "../scripts/migrations";
import { poolConfig } from "../src/lib/db";
import { apiOrigin } from "../worker/client";
const exec = promisify(execFile);
async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise<void>((done) => {
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.kill("SIGTERM");
  });
}

test("remote database TLS and API origin configuration", () => {
  assert.throws(
    () => poolConfig("postgresql://user:private@remote.example/db", {}),
    /TLS/,
  );
  assert.throws(
    () =>
      poolConfig(
        "postgresql://user:private@remote.example/db?sslmode=no-verify",
        { DATABASE_SSL: "true" },
      ),
    /SSL query parameters/,
  );
  assert.equal(
    (
      poolConfig("postgresql://user:private@remote.example/db", {
        DATABASE_SSL: "true",
      }).ssl as { rejectUnauthorized: boolean }
    ).rejectUnauthorized,
    true,
  );
  assert.throws(() => apiOrigin("http://remote.example"), /HTTPS/);
  assert.throws(
    () => apiOrigin("https://user:private@remote.example"),
    /plain API origin/,
  );
  assert.equal(
    apiOrigin("https://conduit.example").origin,
    "https://conduit.example",
  );
});

test(
  "Next.js HTTP API, admin CLI and separate worker process",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "conduit-http-"));
    const dbPort = await port();
    const httpPort = await port();
    const testDist = `.next-test-${process.pid}`;
    const testConfig = `.tsconfig-test-${process.pid}.json`;
    const requestId = randomUUID();
    await writeFile(testConfig, await readFile("tsconfig.json", "utf8"));
    const originalNextEnv = await readFile("next-env.d.ts", "utf8");
    const postgres = new EmbeddedPostgres({
      databaseDir: join(dir, "db"),
      port: dbPort,
      user: "postgres",
      password: "local-test-password",
      persistent: false,
      autoRehydrateSymlinks: true,
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {},
      onError: () => {},
    });
    let proxy: Server | undefined;
    let admin: pg.Client | undefined,
      server: ChildProcess | undefined,
      worker: ChildProcess | undefined;
    try {
      await postgres.initialise();
      await postgres.start();
      admin = postgres.getPgClient();
      await admin.connect();
      // Test upgrade from the original schema and key format without deleting queue rows.
      const first = "20261104221612_job_queue.sql";
      await admin.query(
        await readFile(join("supabase/migrations", first), "utf8"),
      );
      await admin.query(
        `INSERT INTO orchestrator.api_keys(key_hash,principal,role,expires_at) VALUES($1,'legacy','submitter',clock_timestamp()+interval '1 day')`,
        ["a".repeat(64)],
      );
      const oldJob = (
        await admin.query(
          `INSERT INTO orchestrator.jobs(title,task,submitter_id,request_id) VALUES('Preserved','simulate-development','legacy',$1) RETURNING id`,
          [randomUUID()],
        )
      ).rows[0];
      const applied = await applyMigrations(admin, true);
      assert.equal(applied.length, 4);
      assert.deepEqual(await applyMigrations(admin), []);
      assert.ok(
        (await admin.query("SELECT revoked_at FROM orchestrator.api_keys"))
          .rows[0].revoked_at,
      );
      assert.equal(
        (await admin.query("SELECT id FROM orchestrator.jobs")).rows[0].id,
        oldJob.id,
      );
      await admin.query("TRUNCATE orchestrator.jobs");
      const url = `postgresql://postgres:local-test-password@127.0.0.1:${dbPort}/postgres`;
      const env = {
        ...process.env,
        ADMIN_DATABASE_URL: url,
        DATABASE_SSL: "false",
        CONDUIT_ADMIN_ENV_FILE: join(dir, "no-env"),
        VERCEL: "",
      };
      const cli = async (args: string[]) =>
        exec(process.execPath, ["--import", "tsx", "scripts/key.ts", ...args], {
          env,
          timeout: 15000,
        });
      const instinctFile = join(dir, "instinct.json"),
        workerFile = join(dir, "worker.json");
      await t.test(
        "CLI creates hashed scoped keys with 30-day default and safe listing",
        async () => {
          const result = await cli([
            "create",
            "--type",
            "instinct",
            "--principal",
            "instinct-http",
            "--name",
            "Instinct HTTP test",
            "--out",
            instinctFile,
          ]);
          const credential = JSON.parse(await readFile(instinctFile, "utf8"));
          assert.match(credential.token, /^cnd_live_[A-Za-z0-9_-]{43}$/);
          assert.ok(!result.stdout.includes(credential.token));
          const row = (
            await admin!.query(
              "SELECT * FROM orchestrator.api_keys WHERE id=$1",
              [credential.id],
            )
          ).rows[0];
          assert.notEqual(row.key_hash, credential.token);
          assert.equal(row.key_prefix, credential.token.slice(0, 17));
          assert.deepEqual(row.scopes, ["jobs:create", "jobs:read"]);
          assert.ok(
            Math.abs(
              new Date(row.expires_at).getTime() - Date.now() - 30 * 86400000,
            ) < 10000,
          );
          assert.ok(!JSON.stringify(row).includes(credential.token));
          const listed = await cli(["list"]);
          assert.ok(!listed.stdout.includes(credential.token));
          assert.ok(!listed.stdout.includes(row.key_hash));
          await cli([
            "create",
            "--type",
            "worker",
            "--principal",
            "mac-http",
            "--name",
            "Mac worker test",
            "--days",
            "7",
            "--out",
            workerFile,
          ]);
        },
      );
      await t.test(
        "runtime bootstrap creates restricted server login without printing password",
        async () => {
          // It writes to its normal ignored location, so use a separate cwd with only its output directory,
          // while loading the absolute CLI entry point and dependencies from this checkout.
          const cwd = join(dir, "bootstrap");
          await mkdir(cwd);
          const result = await exec(
            process.execPath,
            [
              "--import",
              resolve("node_modules/tsx/dist/loader.mjs"),
              resolve("scripts/runtime-role.ts"),
            ],
            { env, cwd, timeout: 15000 },
          );
          assert.match(result.stdout, /Runtime connection written/);
          const saved = await readFile(
            join(cwd, ".secrets/runtime-database.env"),
            "utf8",
          );
          const match = saved.match(/DATABASE_URL="([^"]+)"/);
          assert.ok(match);
          const runtime = new pg.Client({ connectionString: match[1] });
          await runtime.connect();
          try {
            assert.equal(
              (await runtime.query("SHOW statement_timeout")).rows[0]
                .statement_timeout,
              "10s",
            );
            await assert.rejects(
              runtime.query("SELECT * FROM orchestrator.api_keys"),
              /permission denied/,
            );
            await assert.rejects(
              runtime.query("SELECT * FROM conduit_meta.schema_migrations"),
              /permission denied/,
            );
          } finally {
            await runtime.end();
          }
          const role = (
            await admin!.query(
              "SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname='conduit_runtime'",
            )
          ).rows[0];
          assert.deepEqual(Object.values(role), [false, false, false, false]);
          await assert.rejects(
            exec(
              process.execPath,
              [
                "--import",
                resolve("node_modules/tsx/dist/loader.mjs"),
                resolve("scripts/runtime-role.ts"),
              ],
              { env, cwd, timeout: 15000 },
            ),
          );
          assert.ok(!result.stdout.includes(new URL(match[1]).password));
        },
      );
      const runtimeFile = await readFile(
        join(dir, "bootstrap/.secrets/runtime-database.env"),
        "utf8",
      );
      const runtimeUrl = runtimeFile.match(/DATABASE_URL="([^"]+)"/)![1];
      const serverEnv = {
        ...process.env,
        DATABASE_URL: runtimeUrl,
        DATABASE_SSL: "false",
        CONDUIT_TEST_DIST_DIR: testDist,
        CONDUIT_TEST_TSCONFIG: testConfig,
        VERCEL: "",
        NEXT_TELEMETRY_DISABLED: "1",
      };
      let serverOutput = "";
      server = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(httpPort),
        ],
        { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      server.stdout!.on("data", (chunk) => {
        serverOutput += String(chunk);
      });
      server.stderr!.on("data", (chunk) => {
        serverOutput += String(chunk);
      });
      const origin = `http://127.0.0.1:${httpPort}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(origin, { signal: AbortSignal.timeout(1000) });
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await pause(200);
      }
      assert.ok(ready, "Next.js must start");
      const instinct = JSON.parse(await readFile(instinctFile, "utf8"));
      const request = async (
        path: string,
        body?: unknown,
        key = instinct.token,
        id = randomUUID(),
      ) =>
        fetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "Idempotency-Key": id,
          },
          signal: AbortSignal.timeout(15000),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      await t.test(
        "root health and auth-check routes work over HTTP",
        async () => {
          const ready = await fetch(origin + "/health");
          assert.equal(ready.status, 200);
          assert.equal((await ready.json()).database, "ok");
          assert.equal((await fetch(origin + "/auth-check")).status, 401);
          const valid = await request("/auth-check");
          assert.equal(valid.status, 200);
          assert.equal((await valid.json()).instinct_access, true);
          const workerCredential = JSON.parse(
            await readFile(workerFile, "utf8"),
          );
          assert.equal(
            (await request("/auth-check", undefined, workerCredential.token))
              .status,
            403,
          );
        },
      );
      await t.test(
        "real HTTP API and worker recover from a dropped network request through runtime login",
        async () => {
          const root = await (await fetch(origin)).json();
          assert.equal(root.service, "Conduit POC");
          assert.equal((await fetch(origin + "/api/jobs")).status, 401);
          assert.equal((await request("/api/keys")).status, 404);
          let workerOutput = "";
          let disconnected = false;
          proxy = httpServer(async (incoming, outgoing) => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            if (!disconnected && incoming.url?.endsWith("/report")) {
              disconnected = true;
              incoming.socket.destroy();
              return;
            }
            try {
              const response = await fetch(origin + incoming.url, {
                method: incoming.method,
                headers: {
                  Authorization: incoming.headers.authorization ?? "",
                  "Content-Type": "application/json",
                },
                body: Buffer.concat(chunks),
                signal: AbortSignal.timeout(15000),
                redirect: "error",
              });
              outgoing.writeHead(response.status, {
                "Content-Type": "application/json",
              });
              outgoing.end(await response.text());
            } catch {
              outgoing.writeHead(503);
              outgoing.end();
            }
          });
          await new Promise<void>((done) =>
            proxy!.listen(0, "127.0.0.1", done),
          );
          const workerOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
          worker = spawn(
            process.execPath,
            ["--import", "tsx", "worker/index.ts"],
            {
              env: {
                ...process.env,
                CONDUIT_API_URL: workerOrigin,
                WORKER_KEY_FILE: workerFile,
                WORKER_STATE_DIR: join(dir, "worker-state"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          worker.stdout!.on("data", (chunk) => {
            workerOutput += String(chunk);
          });
          worker.stderr!.on("data", (chunk) => {
            workerOutput += String(chunk);
          });
          const probe = await exec(
            process.execPath,
            ["--import", "tsx", "scripts/smoke.ts"],
            {
              env: {
                ...process.env,
                CONDUIT_API_URL: origin,
                SUBMITTER_KEY_FILE: instinctFile,
                REQUEST_ID: requestId,
              },
              timeout: 90000,
            },
          );
          assert.match(probe.stdout, /"status":"completed"/);
          assert.equal(disconnected, true);
          assert.match(workerOutput, /"event":"retry"/);
          assert.match(probe.stdout, /"simulated":true/);
          assert.ok(!probe.stdout.includes(instinct.token));
          assert.ok(
            !workerOutput.includes(
              JSON.parse(await readFile(workerFile, "utf8")).token,
            ),
          );
          const {
            rows: [job],
          } = await admin!.query(
            "SELECT * FROM orchestrator.jobs WHERE submitter_id='instinct-http'",
          );
          assert.equal(job.status, "completed");
          assert.equal(job.worker_id, "mac-http");
          assert.ok(job.completed_at);
          const listed = await (await request("/api/jobs")).json();
          assert.equal(listed.jobs[0].claim_token, undefined);
          await stop(worker);
          worker = undefined;
        },
      );
      await t.test(
        "rotation preserves principal ownership; revocation takes effect on next HTTP request",
        async () => {
          const rotated = join(dir, "rotated.json");
          await cli([
            "create",
            "--type",
            "instinct",
            "--principal",
            "instinct-http",
            "--name",
            "Rotated",
            "--out",
            rotated,
          ]);
          const next = JSON.parse(await readFile(rotated, "utf8"));
          const r = await request("/api/jobs", undefined, next.token);
          assert.equal(r.status, 200);
          assert.equal((await r.json()).jobs.length, 1);
          await cli(["revoke", instinct.id]);
          assert.equal((await request("/api/jobs")).status, 401);
          assert.equal(
            (await request("/api/jobs", undefined, next.token)).status,
            200,
          );
        },
      );
      assert.ok(!serverOutput.includes(instinct.token));
    } finally {
      await stop(worker);
      if (proxy) await new Promise<void>((done) => proxy!.close(() => done()));
      await stop(server);
      await admin?.end();
      await postgres.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      await rm(testDist, { recursive: true, force: true });
      await rm(testConfig, { force: true });
      await writeFile("next-env.d.ts", originalNextEnv);
      await rm(join(".secrets", `smoke-${requestId}.json`), { force: true });
    }
  },
);
