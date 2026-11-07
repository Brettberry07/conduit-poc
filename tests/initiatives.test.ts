import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { applyMigrations } from "../scripts/migrations";
import { handle } from "../src/lib/api";
import { generateKey, hashKey } from "../src/lib/keys";
import { checkInitiatives } from "./helpers/initiatives";

test(
  "Phase 5B durable initiative acceptance with real PostgreSQL and runtime permissions",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "conduit-initiatives-")),
      server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const postgres = new EmbeddedPostgres({
      databaseDir: join(dir, "db"),
      port,
      user: "postgres",
      password: "test-only",
      persistent: false,
      autoRehydrateSymlinks: true,
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {},
      onError: () => {},
    });
    let db: pg.Pool | undefined, runtime: pg.Pool | undefined;
    try {
      await postgres.initialise();
      await postgres.start();
      db = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: "test-only",
        database: "postgres",
        max: 12,
      });
      const client = await db.connect();
      try {
        await applyMigrations(client as unknown as pg.Client);
      } finally {
        client.release();
      }
      await db.query(
        "CREATE ROLE phase5b_runtime LOGIN PASSWORD 'runtime-only' INHERIT; GRANT conduit_api TO phase5b_runtime",
      );
      runtime = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "phase5b_runtime",
        password: "runtime-only",
        database: "postgres",
        max: 12,
      });
      const keys = {
        submitter: generateKey().token,
        other: generateKey().token,
        reader: generateKey().token,
        worker: generateKey().token,
      };
      for (const [name, token] of Object.entries(keys))
        await db.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at) VALUES($1,$2,$3,$2,$4,$5,clock_timestamp()+interval '1 hour')`,
          [
            hashKey(token),
            name === "reader" ? "submitter" : name,
            name === "worker" ? "worker" : "submitter",
            token.slice(0, 17),
            name === "worker"
              ? ["jobs:claim", "jobs:update"]
              : name === "reader"
                ? ["jobs:read"]
                : ["jobs:read", "jobs:create", "jobs:revise"],
          ],
        );
      const project = randomUUID();
      await db.query(
        `INSERT INTO orchestrator.projects(id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches) VALUES($1,'Conduit fixture','example','disposable','https://github.com/example/disposable.git','main',ARRAY['main'])`,
        [project],
      );
      const req = (
        path: string,
        method = "GET",
        body?: unknown,
        key: keyof typeof keys = "submitter",
        requestId = randomUUID(),
      ) =>
        handle(
          new Request("http://localhost" + path, {
            method,
            headers: {
              Authorization: "Bearer " + keys[key],
              "Content-Type": "application/json",
              "Idempotency-Key": requestId,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          runtime!,
        );
      await checkInitiatives(req, db, project);
      const {
        rows: [completion],
      } = await db.query(
        `SELECT e.data FROM orchestrator.events e JOIN orchestrator.initiatives i
         ON i.id=e.initiative_id AND i.owner=e.owner
         WHERE e.type='initiative.completed' AND i.status='completed'`,
      );
      assert.equal(completion?.data.status, "completed");
      const tables = (
        await db.query(
          `SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='orchestrator' AND relname LIKE 'initiative%'`,
        )
      ).rows;
      assert.equal(tables.filter((r) => r.relrowsecurity).length, 5); // five focused persistence tables
      await assert.rejects(
        runtime.query(
          "UPDATE orchestrator.initiative_plan_versions SET version=99",
        ),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query("DELETE FROM orchestrator.initiative_reviews"),
        /permission denied/,
      );
    } finally {
      await runtime?.end();
      await db?.end();
      await postgres.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
