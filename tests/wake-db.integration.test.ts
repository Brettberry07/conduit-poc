import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { handle } from "../src/lib/api";
import { generateKey } from "../src/lib/keys";
test(
  "disposable PostgreSQL: atomic generations, fixed-pool publish, rate/idempotency and receiver RLS",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-db-"));
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const password = randomBytes(24).toString("hex");
    const db = new EmbeddedPostgres({
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
    let pool: pg.Pool | undefined;
    try {
      await db.initialise();
      await db.start();
      pool = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password,
        database: "postgres",
      });
      for (const f of (await readdir("supabase/migrations")).sort())
        await pool.query(
          await readFile(join("supabase/migrations", f), "utf8"),
        );
      await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;CREATE SCHEMA realtime;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('realtime.topic',true)$$;
 CREATE TABLE realtime.messages(extension text,payload jsonb,topic text,event text,private boolean);ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA realtime,auth TO authenticated;GRANT SELECT ON realtime.messages TO authenticated;
 CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN INSERT INTO realtime.messages VALUES('broadcast',payload || jsonb_build_object('id',coalesce(payload->>'id',gen_random_uuid()::text)),topic,event,private);EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send failed';END$$;`);
      await pool.query(
        await readFile("docs/proposed/private-worker-wake.sql", "utf8"),
      );
      await pool.query("UPDATE orchestrator.wake_control SET enabled=true");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          `INSERT INTO orchestrator.jobs(title,description,task,submitter_id,request_id) VALUES('rollback','','simulate-development','a','00000000-0000-4000-8000-000000000001')`,
        );
        assert.equal(
          (await c.query("SELECT generation FROM orchestrator.wake_control"))
            .rows[0].generation,
          "1",
        );
        await c.query("ROLLBACK");
        assert.equal(
          (await c.query("SELECT generation FROM orchestrator.wake_control"))
            .rows[0].generation,
          "0",
        );
        await c.query(
          `INSERT INTO orchestrator.jobs(title,description,task,submitter_id,request_id) VALUES('commit','','simulate-development','a','00000000-0000-4000-8000-000000000002')`,
        );
        await c.query("SELECT orchestrator.flush_worker_wake()");
        assert.equal(
          (await c.query("SELECT count(*) FROM realtime.messages")).rows[0]
            .count,
          "1",
        );
        await c.query("SELECT orchestrator.flush_worker_wake()");
        assert.equal(
          (await c.query("SELECT count(*) FROM realtime.messages")).rows[0]
            .count,
          "1",
        );
        await c.query(
          `INSERT INTO orchestrator.wake_callers(principal) VALUES('owner')`,
        );
        const request = (id: string) =>
          c.query("SELECT * FROM orchestrator.request_worker_wake($1,$2)", [
            "owner",
            id,
          ]);
        assert.equal(
          (await request("00000000-0000-4000-8000-000000000003")).rows[0]
            .accepted,
          true,
        );
        assert.equal(
          (await request("00000000-0000-4000-8000-000000000003")).rows[0]
            .accepted,
          true,
        );
        assert.equal(
          (await request("00000000-0000-4000-8000-000000000004")).rows[0]
            .accepted,
          false,
        );
        await c.query(
          `INSERT INTO orchestrator.wake_subscribers VALUES('00000000-0000-4000-8000-000000000005','conduit:pool:shared')`,
        );
        await c.query("SET ROLE authenticated");
        await c.query(
          `SET "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000005'; SET "realtime.topic"='conduit:pool:shared'`,
        );
        assert.equal(
          (await c.query("SELECT count(*) FROM realtime.messages")).rows[0]
            .count,
          "1",
        );
        await c.query(`SET "realtime.topic"='conduit:pool:other'`);
        assert.equal(
          (await c.query("SELECT count(*) FROM realtime.messages")).rows[0]
            .count,
          "0",
        );
        await assert.rejects(
          c.query(
            `INSERT INTO realtime.messages(extension,payload) VALUES('broadcast','{}')`,
          ),
          /permission denied/,
        );
        await assert.rejects(
          c.query("SELECT * FROM orchestrator.jobs"),
          /permission denied/,
        );
        await assert.rejects(
          c.query("SELECT * FROM orchestrator.auth_users"),
          /permission denied/,
        );
        await assert.rejects(
          c.query("SELECT * FROM orchestrator.wake_subscribers"),
          /permission denied/,
        );
        await assert.rejects(
          c.query("SELECT orchestrator.flush_worker_wake()"),
          /permission denied/,
        );
        await c.query(
          `SET "realtime.topic"='conduit:pool:shared'; SET "request.jwt.claim.sub"='00000000-0000-4000-8000-000000000099'`,
        );
        assert.equal(
          (await c.query("SELECT count(*) FROM realtime.messages")).rows[0]
            .count,
          "0",
        );
        await c.query("RESET ROLE");
        // Actual DB trigger coverage for initial/retry queueing, pause/resume,
        // verified merge observation before claim-time dependency promotion, project enable.
        const generation = async () =>
          Number(
            (await c.query("SELECT generation FROM orchestrator.wake_control"))
              .rows[0].generation,
          );
        const baseline = await generation();
        await c.query(
          `UPDATE orchestrator.jobs SET status='blocked',completed_at=clock_timestamp() WHERE title='commit'`,
        );
        assert.equal(await generation(), baseline);
        await c.query(
          `UPDATE orchestrator.jobs SET status='queued',completed_at=NULL WHERE title='commit'`,
        );
        assert.equal(await generation(), baseline + 1);
        await c.query(
          `INSERT INTO orchestrator.projects(id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches,enabled) VALUES('00000000-0000-4000-8000-000000000010','fixture','fixture','fixture','https://example.invalid/fixture','main',ARRAY['main'],false)`,
        );
        await c.query(
          `UPDATE orchestrator.projects SET enabled=true WHERE id='00000000-0000-4000-8000-000000000010'`,
        );
        assert.equal(await generation(), baseline + 2);
        await c.query(
          `INSERT INTO orchestrator.initiatives(id,owner,project_id,request_id,creation_content,plan) VALUES('00000000-0000-4000-8000-000000000011','a','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000012','{}','{}')`,
        );
        await c.query(
          `UPDATE orchestrator.initiatives SET status='active' WHERE id='00000000-0000-4000-8000-000000000011'`,
        );
        await c.query(
          `UPDATE orchestrator.initiatives SET status='paused' WHERE id='00000000-0000-4000-8000-000000000011'`,
        );
        assert.equal(await generation(), baseline + 3);
        await c.query(
          `UPDATE orchestrator.initiatives SET status='active' WHERE id='00000000-0000-4000-8000-000000000011'`,
        );
        assert.equal(await generation(), baseline + 4);
        await c.query(
          `INSERT INTO orchestrator.jobs(id,title,task,submitter_id,request_id,instructions,project_id,root_job_id,base_branch) VALUES('00000000-0000-4000-8000-000000000013','root','development','a','00000000-0000-4000-8000-000000000014','fixture','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000013','main')`,
        );
        assert.equal(await generation(), baseline + 5);
        await c.query(
          `INSERT INTO orchestrator.development_tasks(job_id,project_id,branch,base_branch,pull_request) VALUES('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000010','test','main','{"merged":false}')`,
        );
        await c.query(
          `UPDATE orchestrator.development_tasks SET pull_request='{"merged":true}' WHERE job_id='00000000-0000-4000-8000-000000000013'`,
        );
        assert.equal(await generation(), baseline + 6);
        await c.query(
          `UPDATE orchestrator.development_tasks SET pull_request='{"merged":true}' WHERE job_id='00000000-0000-4000-8000-000000000013'`,
        );
        assert.equal(await generation(), baseline + 6);
        await c.query("SET ROLE conduit_api");
        await assert.rejects(
          c.query("SELECT * FROM orchestrator.wake_subscribers"),
          /permission denied/,
        );
        await c.query("SELECT orchestrator.flush_worker_wake()");
        await c.query("RESET ROLE");
        const credential = generateKey();
        await c.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at) VALUES($1,'operator','submitter','disposable',$2,ARRAY['jobs:wake'],clock_timestamp()+interval '1 day')`,
          [credential.hash, credential.prefix],
        );
        await c.query(
          `INSERT INTO orchestrator.wake_callers(principal) VALUES('operator')`,
        );
        const oldFlag = process.env.CONDUIT_WAKE_ENABLED;
        process.env.CONDUIT_WAKE_ENABLED = "true";
        try {
          const send = (value: unknown, token = credential.token) =>
            handle(
              new Request("https://example.invalid/api/worker-wake", {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + token,
                  "Content-Type": "application/json",
                  "Idempotency-Key": "00000000-0000-4000-8000-000000000006",
                },
                body: JSON.stringify(value),
              }),
              pool!,
            );
          assert.equal((await send({})).status, 202);
          assert.equal((await send({})).status, 202);
          assert.equal((await send({ command: "run" })).status, 400);
          assert.equal((await send({}, "invalid")).status, 401);
          assert.equal((await send({ padding: "x".repeat(200) })).status, 400);
        } finally {
          if (oldFlag === undefined) delete process.env.CONDUIT_WAKE_ENABLED;
          else process.env.CONDUIT_WAKE_ENABLED = oldFlag;
        }
        // Delivery failure leaves the same durable generation pending for later recovery.
        await c.query(
          `CREATE OR REPLACE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE WARNING 'offline';END$$`,
        );
        await c.query(
          `UPDATE orchestrator.wake_control SET generation=generation+1,next_attempt='-infinity'`,
        );
        const before = (
          await c.query(
            "SELECT generation,delivered FROM orchestrator.wake_control",
          )
        ).rows[0];
        await c.query("SELECT orchestrator.flush_worker_wake()");
        const after = (
          await c.query(
            "SELECT generation,delivered,failures FROM orchestrator.wake_control",
          )
        ).rows[0];
        assert.equal(after.generation, before.generation);
        assert.equal(after.delivered, before.delivered);
        assert.equal(after.failures, 1);
      } finally {
        c.release();
      }
    } finally {
      await pool?.end();
      await db.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
