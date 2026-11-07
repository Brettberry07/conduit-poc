import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { applyMigrations } from "../scripts/migrations";
import { handle } from "../src/lib/api";
import { policyVersion } from "../src/lib/agent-protocol";
import { credentialScopes, generateKey, hashKey } from "../src/lib/keys";
import { examplePlan } from "./helpers/initiatives";

const feed = "/api/agent/events";
const consumer = "/api/agent/event-consumers/instinct-primary";
const secret = "github_pat_SHOULD_NEVER_ENTER_EVENTS";
const head = "a".repeat(40);

async function withDatabase(
  run: (admin: pg.Pool, runtime: pg.Pool) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "conduit-events-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const config = { host: "127.0.0.1", port, database: "postgres", max: 12 };
  const admin = new pg.Pool({
    ...config,
    user: "postgres",
    password: "test-only",
  });
  const runtime = new pg.Pool({
    ...config,
    user: "events_runtime",
    password: "runtime-only",
  });
  try {
    await postgres.initialise();
    await postgres.start();
    const client = await admin.connect();
    try {
      await applyMigrations(client as unknown as pg.Client);
    } finally {
      client.release();
    }
    await admin.query(
      "CREATE ROLE events_runtime LOGIN PASSWORD 'runtime-only' INHERIT; GRANT conduit_api TO events_runtime",
    );
    await run(admin, runtime);
  } finally {
    await runtime.end();
    await admin.end();
    await postgres.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "Phase 5C acceptance: durable initiative activity, worker writes and interrupted consumer",
  { timeout: 120000 },
  async () => {
    await withDatabase(async (admin, runtime) => {
      const keys = {
        owner: generateKey(),
        viewer: generateKey(),
        worker: generateKey(),
        other: generateKey(),
      };
      type Key = keyof typeof keys;
      for (const [name, { token, prefix }] of Object.entries(keys)) {
        await admin.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')`,
          [
            hashKey(token),
            name === "viewer" ? "owner" : name,
            name === "worker" ? "worker" : "submitter",
            name,
            prefix,
            credentialScopes[
              name === "worker" || name === "viewer" ? name : "instinct"
            ],
          ],
        );
      }
      const request = (
        path: string,
        method = "GET",
        body?: unknown,
        key: Key = "owner",
        requestId = randomUUID(),
      ) =>
        handle(
          new Request("http://localhost" + path, {
            method,
            headers: {
              Authorization: "Bearer " + keys[key].token,
              "Content-Type": "application/json",
              "Idempotency-Key": requestId,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          runtime,
        );
      const ok = async (response: Promise<Response>, status = 200) => {
        const res = await response;
        assert.equal(res.status, status, await res.clone().text());
        assert.equal(res.headers.get("cache-control"), "no-store");
        return res.json();
      };
      const get = (path: string, key?: Key) =>
        ok(request(path, "GET", undefined, key));
      const post = (
        path: string,
        body: unknown,
        key?: Key,
        requestId?: ReturnType<typeof randomUUID>,
        status = 201,
      ) => ok(request(path, "POST", body, key, requestId), status);
      const worker = (path: string, body: unknown = {}) =>
        post(path, body, "worker", undefined, 200);
      const read = (after = "0", limit = 100) =>
        get(`${feed}?after=${after}&limit=${limit}`, "viewer");
      const ack = (
        cursor: string,
        expected_previous_cursor: string,
        path = consumer,
      ) => request(path + "/ack", "POST", { cursor, expected_previous_cursor });
      const project = randomUUID();
      await admin.query(
        `INSERT INTO orchestrator.projects(id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches)
       VALUES($1,'Event fixture','example','disposable','https://github.com/example/disposable.git','main',ARRAY['main'])`,
        [project],
      );
      assert.deepEqual(await read(), {
        events: [],
        next_after: "0",
        has_more: false,
      });
      assert.deepEqual((await get(consumer, "viewer")).consumer, {
        name: "instinct-primary",
        acknowledged_cursor: "0",
        created_at: null,
        acknowledged_at: null,
      });

      const plan = examplePlan(project);
      const createId = randomUUID();
      const createBody = { plan, policy_version: policyVersion() };
      const { initiative } = await post(
        "/api/initiatives",
        createBody,
        "owner",
        createId,
      );
      assert.equal(
        (await post("/api/initiatives", createBody, "owner", createId))
          .initiative.id,
        initiative.id,
      );
      const path = `/api/initiatives/${initiative.id}`;
      await ok(
        request(path + "/plan", "PATCH", {
          expected_plan_version: 1,
          plan: { ...plan, goal: "Revised goal" },
        }),
      );
      const activateId = randomUUID();
      const activateBody = {
        expected_plan_version: 2,
        policy_version: policyVersion(),
      };
      const activation = await post(
        path + "/activate",
        activateBody,
        "owner",
        activateId,
      );
      assert.deepEqual(
        await post(path + "/activate", activateBody, "owner", activateId),
        activation,
      );
      const jobIds = new Map<string, string>(
        activation.jobs.map((job: any) => [job.task_key, job.root_job_id]),
      );
      const first = await read("0", 3);
      assert.deepEqual(
        first.events.map((e: any) => e.type),
        ["initiative.created", "initiative.plan_updated", "job.created"],
      );
      assert.deepEqual(first.events[1].data, {
        previous_plan_version: 1,
        plan_version: 2,
      });
      assert.equal(first.events[2].task_key, "agent-interface");
      assert.equal(first.events[2].job_id, jobIds.get("agent-interface"));
      assert.ok(first.has_more);
      const firstAck = await ok(ack(first.next_after, "0"));
      assert.deepEqual(await ok(ack(first.next_after, "0")), firstAck);

      const claim = () => worker("/api/claim");
      const [{ job: one }, { job: two }] = await Promise.all([
        claim(),
        claim(),
      ]);
      assert.deepEqual(
        new Set([one.id, two.id]),
        new Set([
          jobIds.get("agent-interface"),
          jobIds.get("claude-configuration"),
        ]),
      );
      assert.equal((await claim()).job, null);
      await ok(
        request(path, "PATCH", { expected_status: "active", status: "paused" }),
      );
      const publish = (job: any, data: unknown) =>
        worker(`/api/jobs/${job.id}/publication`, {
          claim_token: job.claim_token,
          ...(data as object),
        });
      const terminal = (job: any, action = "completed") =>
        worker(`/api/jobs/${job.id}/report`, {
          claim_token: job.claim_token,
          action,
          ...(action === "completed"
            ? {
                result: {
                  verification: { status: "passed", output: secret },
                  path: "/Users/private/worktree",
                },
              }
            : { error: secret, result: { verification: { status: secret } } }),
        });
      const prFor = (number: number) => ({
        number,
        url: `https://github.com/example/disposable/pull/${number}`,
        draft: true,
        state: "open",
        merged: false,
        head,
      });
      await Promise.all(
        [one, two].map(async (job, i) => {
          await worker("/api/heartbeat");
          await worker(`/api/jobs/${job.id}/report`, {
            claim_token: job.claim_token,
            action: "progress",
            progress: 10,
          });
          await publish(job, {
            phase: "running",
            publication_state: "prepared",
          });
          await publish(job, { phase: "verifying" });
          await publish(job, { phase: "verifying" });
          await publish(job, {
            phase: "publishing",
            publication_state: "verified",
          });
          await publish(job, {
            phase: "publishing",
            publication_state: "pushed",
            head_commit: head,
          });
          await publish(job, {
            phase: "publishing",
            publication_state: "published",
            pull_request: prFor(i + 1),
          });
          await terminal(job);
          await terminal(job);
        }),
      );
      assert.equal(
        (await claim()).job,
        null,
        "pause does not stop reports and does fence dispatch",
      );

      const saved = (await get(consumer)).consumer.acknowledged_cursor;
      assert.equal(saved, first.next_after);
      const missed = await read(saved);
      assert.equal(missed.has_more, false);
      assert.ok(
        missed.events.every((e: any) => BigInt(e.cursor) > BigInt(saved)),
      );
      assert.equal(
        missed.events.filter((e: any) => e.type === "initiative.activated")
          .length,
        1,
      );
      const activationEvents = [...first.events, ...missed.events].filter(
        (e) => e.type === "job.created",
      );
      assert.equal(activationEvents.length, jobIds.size);
      assert.deepEqual(
        new Set(activationEvents.map((e) => e.job_id)),
        new Set(jobIds.values()),
      );
      assert.ok(
        activationEvents.every(
          (e) =>
            e.initiative_id === initiative.id &&
            e.project_id === project &&
            e.root_job_id === e.job_id,
        ),
      );
      for (const job of [one, two]) {
        const types = missed.events
          .filter((e: any) => e.job_id === job.id && e.type !== "job.created")
          .map((e: any) => e.type);
        assert.deepEqual(types, [
          "job.claimed",
          "job.phase_changed",
          "job.phase_changed",
          "job.phase_changed",
          "publication.verified",
          "publication.pushed",
          "pull_request.created",
          "job.completed",
        ]);
      }
      assert.ok(missed.events.some((e: any) => e.type === "initiative.paused"));
      assert.doesNotMatch(
        JSON.stringify(missed),
        new RegExp(`${secret}|/Users/|claim_token|${one.claim_token}`),
      );
      assert.deepEqual(
        missed.events.find((e: any) => e.type === "job.completed").data,
        { attempt: 1, result_available: true, verification_status: "passed" },
      );

      const reviewId = randomUUID();
      const assessment = {
        task_key: activation.jobs.find((j: any) => j.root_job_id === one.id)
          .task_key,
        job_id: one.id,
        observed_head_sha: head,
        outcome: "revision_needed",
        summary: "One acceptance gap",
        criteria_evaluated: ["Behavior matches the stated goal"],
      };
      const { review } = await post(
        path + "/reviews",
        assessment,
        "owner",
        reviewId,
      );
      const replay = await read(
        (await get(consumer)).consumer.acknowledged_cursor,
      );
      assert.deepEqual(
        replay.events.slice(0, missed.events.length),
        missed.events,
      );
      const reviewEvent = replay.events.at(-1);
      assert.equal(reviewEvent.type, "initiative.review_recorded");
      assert.deepEqual(reviewEvent.data, {
        review_id: review.id,
        outcome: "revision_needed",
      });
      assert.equal(
        (await get(path + "/reviews?review_id=" + review.id)).reviews[0].id,
        review.id,
      );
      assert.equal(
        (await post(path + "/reviews", assessment, "owner", reviewId)).review
          .id,
        review.id,
      );
      assert.equal(
        (await read(saved)).next_after,
        replay.next_after,
        "replay and retries did not write events",
      );
      assert.equal(
        (await get(path + "/resume")).activity.latest_cursor,
        replay.next_after,
      );
      await ok(ack(replay.next_after, saved));
      assert.deepEqual(await read(replay.next_after), {
        events: [],
        next_after: replay.next_after,
        has_more: false,
      });

      const history = await get(
        feed + "?initiative_id=" + initiative.id + "&limit=1",
        "viewer",
      );
      assert.equal(history.events[0].id, reviewEvent.id);
      assert.equal(history.next_after, undefined);
      const older = await get(
        feed +
          "?initiative_id=" +
          initiative.id +
          "&before=" +
          history.next_before,
        "viewer",
      );
      assert.equal(history.next_before, reviewEvent.id);
      assert.equal(history.events[0].cursor, undefined);
      assert.ok(older.events.length > 0);
      assert.ok(older.events.every((e: any) => e.id !== reviewEvent.id));
      assert.equal(
        (await ack(history.next_before, replay.next_after)).status,
        400,
      );
      assert.deepEqual(
        (
          await get(
            feed + "?job_id=" + two.id + "&before=" + history.next_before,
          )
        ).events,
        [],
      );
      assert.ok(
        (await get(feed + "?job_id=" + one.id)).events.every(
          (e: any) => e.job_id === one.id,
        ),
      );
      assert.deepEqual(
        (await get(feed + "?initiative_id=" + initiative.id, "other")).events,
        [],
      );
      assert.deepEqual(
        (await get(feed + "?job_id=" + one.id, "other")).events,
        [],
      );
      assert.deepEqual((await get(feed, "other")).events, []);
      assert.equal(
        (await get(consumer, "other")).consumer.acknowledged_cursor,
        "0",
      );
      const ackBody = {
        cursor: replay.next_after,
        expected_previous_cursor: "0",
      };
      assert.equal(
        (await request(consumer + "/ack", "POST", ackBody, "other")).status,
        400,
      );
      assert.equal(
        (await request(consumer + "/ack", "POST", ackBody, "viewer")).status,
        403,
      );
      assert.equal(
        (await request(consumer + "/ack", "POST", ackBody, "worker")).status,
        403,
      );
      assert.equal(
        (await request(feed, "GET", undefined, "worker")).status,
        403,
      );
      assert.equal(
        (await request(consumer, "GET", undefined, "worker")).status,
        403,
      );
      assert.equal(
        (
          await request(
            feed + "?after=" + replay.next_after,
            "GET",
            undefined,
            "other",
          )
        ).status,
        400,
      );
      for (const invalid of [
        "after=-1",
        "after=1e2",
        "after=00",
        "after=1%0A",
        "after=9223372036854775808",
        "after=999999",
        "limit=0",
        "limit=101",
        "limit=1.0",
        "limit=1&limit=2",
        "before=2",
        "job_id=invalid",
        "after=0&job_id=" + one.id,
      ]) {
        assert.equal(
          (await request(feed + "?" + invalid)).status,
          400,
          invalid,
        );
      }
      for (const invalid of ["invalid", "9223372036854775808", "999999"]) {
        assert.equal((await ack(invalid, replay.next_after)).status, 400);
      }
      assert.equal((await ack("0", replay.next_after)).status, 400);
      assert.equal((await ack(saved, "0")).status, 409);
      assert.equal(
        (await request(consumer.replace("instinct-primary", "Invalid"))).status,
        400,
      );
      const monitor = consumer.replace("instinct-primary", "parallel-monitor");
      const race = await Promise.all([
        ack(saved, "0", monitor),
        ack(replay.next_after, "0", monitor),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (await get(monitor)).consumer.acknowledged_cursor,
        race[0].ok ? saved : replay.next_after,
      );
      assert.equal(
        (await get(consumer)).consumer.acknowledged_cursor,
        replay.next_after,
      );

      await ok(
        request(path, "PATCH", { expected_status: "paused", status: "active" }),
      );
      const observed = async (jobId: string, pr: object) =>
        worker("/api/development/reconcile", {
          root_job_id: jobId,
          pull_request: pr,
        });
      await observed(one.id, { ...prFor(1), state: "closed" });
      await observed(one.id, { ...prFor(1), state: "closed" });
      await observed(one.id, { ...prFor(1), state: "closed", merged: true });
      await observed(one.id, prFor(1)); // A stale open observation must preserve a recorded merge.
      await observed(one.id, { ...prFor(1), state: "closed", merged: true });
      await observed(two.id, { ...prFor(2), state: "closed", merged: true });
      const { job: downstream } = await claim();
      assert.equal(downstream.id, jobIds.get("claude-provider"));
      await terminal(downstream, "failed");
      assert.equal((await claim()).job, null);
      await ok(
        request(path, "PATCH", {
          expected_status: "active",
          status: "cancelled",
        }),
      );
      const tail = (await read(replay.next_after)).events;
      assert.deepEqual(
        tail.map((e: any) => e.type),
        [
          "initiative.resumed",
          "pull_request.closed_observed",
          "pull_request.merged_observed",
          "pull_request.merged_observed",
          "job.dependencies_resolved",
          "job.claimed",
          "job.failed",
          "job.blocked",
          "initiative.cancelled",
        ],
      );
      const merge = tail[2];
      assert.equal(merge.job_id, one.id);
      assert.ok(
        Date.parse(merge.data.observed_at) <= Date.parse(merge.occurred_at),
      );
      assert.equal(tail[6].data.verification_status, undefined);
      assert.doesNotMatch(JSON.stringify(tail), new RegExp(secret));

      await admin.query(
        "UPDATE orchestrator.jobs SET status='queued',completed_at=NULL,error=NULL,phase=NULL WHERE id=$1 AND status='failed'",
        [downstream.id],
      );
      const recovery = (await read(tail.at(-1).cursor)).events;
      assert.deepEqual(
        recovery.map((e: any) => e.type),
        ["job.requeued"],
      );
      assert.deepEqual(recovery[0].data, {
        previous_status: "failed",
        status: "queued",
        attempt: 1,
      });

      const standaloneRequest = randomUUID();
      const standalone = await post(
        "/api/jobs",
        { title: "Standalone" },
        "owner",
        standaloneRequest,
      );
      assert.equal(
        (
          await post(
            "/api/jobs",
            { title: "Standalone" },
            "owner",
            standaloneRequest,
          )
        ).job.id,
        standalone.job.id,
      );
      const { job: abandoned } = await claim();
      await admin.query(
        "UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [abandoned.id],
      );
      const { job: retried } = await claim();
      assert.equal(retried.id, abandoned.id);
      await terminal(retried);
      const standaloneEvents = (
        await get(feed + "?job_id=" + standalone.job.id)
      ).events;
      assert.deepEqual(
        standaloneEvents.map((e: any) => e.type),
        ["job.completed", "job.retried", "job.claimed", "job.created"],
      );
      assert.ok(
        standaloneEvents.every(
          (e: any) => e.initiative_id === null && e.task_key === null,
        ),
      );

      await assert.rejects(
        runtime.query("UPDATE orchestrator.events SET data='{}'"),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query("DELETE FROM orchestrator.events"),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query(
          "INSERT INTO orchestrator.events(owner,cursor,type,data) VALUES('owner',999,'forged','{}')",
        ),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query("SELECT * FROM orchestrator.event_cursors"),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query(
          "SELECT orchestrator.append_event('owner','forged',NULL,NULL,NULL,NULL,NULL,'{}')",
        ),
        /permission denied/,
      );
      await admin.query("CREATE ROLE events_untrusted");
      const connection = await admin.connect();
      try {
        await connection.query("SET ROLE events_untrusted");
        await assert.rejects(
          connection.query("SELECT * FROM orchestrator.events"),
          /permission denied/,
        );
      } finally {
        await connection.query("RESET ROLE");
        connection.release();
      }
    });
  },
);

test(
  "PostgreSQL cursor allocation follows commit visibility even with overlapping writes",
  { timeout: 30000 },
  async () => {
    await withDatabase(async (admin, runtime) => {
      const principal = "concurrent";
      const { token, prefix } = generateKey();
      await admin.query(
        `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at)
       VALUES($1,$2,'submitter','cursor test',$3,ARRAY['jobs:read','jobs:revise'],clock_timestamp()+interval '1 hour')`,
        [hashKey(token), principal, prefix],
      );
      const auth = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
      const after = async (cursor: string, limit = 1) => {
        const response = await handle(
          new Request(
            `http://localhost${feed}?after=${cursor}&limit=${limit}`,
            { headers: auth },
          ),
          runtime,
        );
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const insert = async (db: pg.Pool | pg.PoolClient, owner = principal) =>
        (
          await db.query(
            `INSERT INTO orchestrator.jobs(title,task,submitter_id,request_id)
         VALUES('Concurrent job','simulate-development',$1,$2) RETURNING id`,
            [owner, randomUUID()],
          )
        ).rows[0].id;
      const a = await runtime.connect(),
        b = await runtime.connect();
      try {
        await a.query("BEGIN");
        const firstWrite = await insert(a);
        const firstCommit = await insert(b);
        const page1 = await after("0");
        assert.equal(page1.events[0].job_id, firstCommit);
        await a.query("COMMIT");
        const page2 = await after(page1.next_after);
        assert.equal(page2.events[0].job_id, firstWrite);
        assert.equal(page2.next_after, "2");

        // Force deferred allocation early in A to exercise the exact skip hazard.
        // B's deferred COMMIT must wait behind A even on a different source row.
        await a.query("BEGIN");
        await a.query(
          "SET CONSTRAINTS orchestrator.event_job_created IMMEDIATE",
        );
        const allocatedFirst = await insert(a);
        assert.equal(
          (
            await a.query(
              "SELECT max(cursor)::text AS cursor FROM orchestrator.events",
            )
          ).rows[0].cursor,
          "3",
        );
        await b.query("BEGIN");
        const allocatedSecond = await insert(b);
        const pidA = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        const pidB = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        const commitB = b.query("COMMIT");
        try {
          let blockers: number[] = [];
          for (let i = 0; i < 100 && !blockers.includes(pidA); i++) {
            blockers = (
              await admin.query("SELECT pg_blocking_pids($1) AS pids", [pidB])
            ).rows[0].pids;
            if (!blockers.includes(pidA)) await delay(10);
          }
          assert.ok(
            blockers.includes(pidA),
            "later transaction is waiting on the first allocation",
          );
          assert.deepEqual(await after("2"), {
            events: [],
            next_after: "2",
            has_more: false,
          });
        } finally {
          await a.query("COMMIT");
          await commitB;
        }
        const page3 = await after("2");
        assert.equal(page3.events[0].job_id, allocatedFirst);
        assert.equal(page3.has_more, true);
        const page4 = await after(page3.next_after);
        assert.equal(page4.events[0].job_id, allocatedSecond);
        assert.equal(page4.next_after, "4");

        await a.query("BEGIN");
        await a.query(
          "SET CONSTRAINTS orchestrator.event_job_created IMMEDIATE",
        );
        const rolledBack = await insert(a);
        await a.query("ROLLBACK");
        assert.equal(
          (
            await admin.query("SELECT id FROM orchestrator.jobs WHERE id=$1", [
              rolledBack,
            ])
          ).rowCount,
          0,
        );
        assert.deepEqual(await after("4"), {
          events: [],
          next_after: "4",
          has_more: false,
        });

        // Bulk reconciliation can write multiple owners in either order.
        const batch = async (db: pg.PoolClient, owners: string[]) => {
          await db.query("BEGIN");
          for (const owner of owners) await insert(db, owner);
          await db.query("COMMIT");
        };
        await Promise.all([
          batch(a, [principal, "second"]),
          batch(b, ["second", principal]),
        ]);
        const batched = await after("4", 100);
        assert.deepEqual(
          batched.events.map((e: any) => e.cursor),
          ["5", "6"],
        );
        const newIds = await Promise.all(
          Array.from({ length: 4 }, () => insert(runtime)),
        );
        const paged = await after(batched.next_after, 100);
        assert.deepEqual(
          paged.events.map((e: any) => e.cursor),
          ["7", "8", "9", "10"],
        );
        assert.deepEqual(
          new Set(paged.events.map((e: any) => e.job_id)),
          new Set(newIds),
        );

        // Test numeric projection and round-tripping at a value unreachable in a normal test run.
        await admin.query(
          "UPDATE orchestrator.event_cursors SET last_cursor=9007199254740992 WHERE owner=$1",
          [principal],
        );
        const largeId = await insert(runtime);
        const large = await after(paged.next_after);
        assert.equal(large.events[0].job_id, largeId);
        assert.equal(large.next_after, "9007199254740993");
        const checkpoint = await handle(
          new Request(`http://localhost${consumer}/ack`, {
            headers: auth,
            method: "POST",
            body: JSON.stringify({
              cursor: large.next_after,
              expected_previous_cursor: "0",
            }),
          }),
          runtime,
        );
        assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
        assert.equal(
          (await checkpoint.json()).consumer.acknowledged_cursor,
          large.next_after,
        );
        assert.deepEqual(await after(large.next_after), {
          events: [],
          next_after: large.next_after,
          has_more: false,
        });

        // A failed append must abort the source write even during autocommit.
        const exhausted = "exhausted-counter";
        await admin.query(
          "INSERT INTO orchestrator.event_cursors(owner,last_cursor) VALUES($1,9223372036854775807)",
          [exhausted],
        );
        await assert.rejects(insert(runtime, exhausted), /bigint out of range/);
        assert.equal(
          (
            await admin.query(
              "SELECT id FROM orchestrator.jobs WHERE submitter_id=$1",
              [exhausted],
            )
          ).rowCount,
          0,
        );
      } finally {
        await Promise.all([a.query("ROLLBACK"), b.query("ROLLBACK")]);
        a.release();
        b.release();
      }
    });
  },
);
