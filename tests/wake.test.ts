import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WakeGate,
  superviseWake,
  IDLE_FALLBACK_MS,
} from "../worker/wake-supervisor";
import { SessionCache, isWakeHint } from "../worker/wake-transport";
import { wakeApi, flushWake } from "../src/lib/wake-api";
import { allowedScopes, type Identity } from "../src/lib/keys";
import { ApiError } from "../worker/runner";
test("strict hint contains no command, arbitrary target or task", () => {
  for (const x of [null, {}, { v: 2 }, { v: 1, command: "run" }, "work", []])
    assert.equal(isWakeHint(x), false);
  assert.equal(isWakeHint({ v: 1 }), true);
  assert.equal(
    isWakeHint({ v: 1, id: "00000000-0000-4000-8000-000000000001" }),
    true,
  );
  for (const x of [
    { v: 1, id: "bad" },
    { v: 1, id: 3 },
    { v: 1, id: "00000000-0000-4000-8000-000000000001", command: "run" },
  ])
    assert.equal(isWakeHint(x), false);
});
test("socket heartbeat uses cached token; near expiry refresh deduplicated", async () => {
  let n = 0,
    now = 0;
  const cache = new SessionCache(
    { access_token: "old", refresh_token: "r", expires_at: 3600 },
    async () => {
      n++;
      return { access_token: "new", refresh_token: "r2", expires_at: 7200 };
    },
    () => now,
  );
  for (let i = 0; i < 100; i++) assert.equal(await cache.token(), "old");
  assert.equal(n, 0);
  now = 3_550_000;
  assert.deepEqual(
    await Promise.all(Array.from({ length: 100 }, () => cache.token())),
    Array(100).fill("new"),
  );
  assert.equal(n, 1);
});
test("gate coalesces hints and retains hints arriving during sweep; exact six hour boundary", async () => {
  const g = new WakeGate();
  g.hint();
  g.hint();
  const epoch = g.begin();
  g.hint();
  g.finish(epoch, 0);
  let waited = 0;
  await g.sleep(
    async (ms) => {
      waited += ms;
    },
    () => 0,
    () => false,
  );
  assert.equal(waited, 0);
  g.finish(g.begin(), 0);
  let clock = IDLE_FALLBACK_MS - 1;
  await g.sleep(
    async (ms) => {
      waited += ms;
      clock += ms;
    },
    () => clock,
    () => false,
  );
  assert.equal(waited, 1);
});
test("actual idle supervisor no heartbeat and only six-hour queue checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-"));
  let clock = 0,
    stop = false,
    claims = 0,
    reconciles = 0;
  const stamps: number[] = [];
  try {
    await superviseWake({
      stateDir: dir,
      limit: 4,
      gate: new WakeGate(),
      now: () => clock,
      stopping: () => stop,
      wait: async (ms) => {
        clock += ms;
      },
      reconcile: async () => {
        stamps.push(clock);
        reconciles++;
        if (reconciles === 2) stop = true;
      },
      call: async (path) => {
        assert.equal(path, "/api/claim");
        claims++;
        return { job: null };
      },
    });
    assert.equal(claims, 4);
    assert.equal(stamps[1] - stamps[0], IDLE_FALLBACK_MS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("malformed recovery fails before network or reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-"));
  await writeFile(join(dir, "journal.json"), "bad");
  let calls = 0;
  try {
    await assert.rejects(
      superviseWake({
        stateDir: dir,
        limit: 4,
        gate: new WakeGate(),
        stopping: () => false,
        wait: async () => {},
        reconcile: async () => {
          calls++;
        },
        call: async () => {
          calls++;
        },
      }),
      /refusing to discard/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("actual supervisor auth denial stops rather than polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-"));
  let calls = 0;
  try {
    await assert.rejects(
      superviseWake({
        stateDir: dir,
        limit: 1,
        gate: new WakeGate(),
        stopping: () => false,
        wait: async () => {
          await new Promise((r) => setImmediate(r));
        },
        reconcile: async () => {},
        call: async () => {
          calls++;
          throw new ApiError(403);
        },
      }),
      ApiError,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("wake route scope is explicit, disabled by default, strict body, stable identity", async () => {
  const previous = process.env.CONDUIT_WAKE_ENABLED;
  let queries = 0;
  const id = "00000000-0000-4000-8000-000000000001";
  const key: Identity = {
    principal: "owner",
    scopes: ["jobs:wake"],
    role: "submitter",
    id,
  };
  const db = {
    query: async (text: string, args?: unknown[]) => {
      queries++;
      assert.ok(text.includes("request_worker_wake"));
      assert.deepEqual(args, ["owner", id]);
      return { rows: [{ accepted: true }], rowCount: 1 };
    },
  };
  const req = () =>
    new Request("https://example.invalid/api/worker-wake", {
      method: "POST",
      headers: { "Idempotency-Key": id },
    });
  try {
    delete process.env.CONDUIT_WAKE_ENABLED;
    assert.equal(
      (await wakeApi(req(), db, key, async () => ({})))?.status,
      404,
    );
    assert.equal(queries, 0);
    process.env.CONDUIT_WAKE_ENABLED = "true";
    assert.deepEqual(allowedScopes("/api/worker-wake", "POST"), ["jobs:wake"]);
    assert.equal(
      (
        await wakeApi(
          req(),
          db,
          { ...key, scopes: ["jobs:create"] },
          async () => ({}),
        )
      )?.status,
      403,
    );
    await assert.rejects(
      wakeApi(req(), db, key, async () => ({ topic: "other" })),
    );
    assert.equal(queries, 0);
    const r = await wakeApi(req(), db, key, async () => ({}));
    assert.equal(r?.status, 202);
    assert.deepEqual(await r?.json(), { accepted: true, delivered: false });
    assert.equal(queries, 1);
  } finally {
    if (previous === undefined) delete process.env.CONDUIT_WAKE_ENABLED;
    else process.env.CONDUIT_WAKE_ENABLED = previous;
  }
});
test("actual private socket adapter joins, rejects injected payloads, catches up on join and closes", async () => {
  const { startWakeTransport } = await import("../worker/wake-transport");
  const dir = await mkdtemp(join(tmpdir(), "wake-socket-"));
  const sessionFile = join(dir, "session");
  await writeFile(
    sessionFile,
    JSON.stringify({
      access_token: "private-session",
      refresh_token: "refresh",
      expires_at: Date.now() / 1000 + 3600,
    }),
    { mode: 0o600 },
  );
  class Socket {
    static OPEN = 1;
    readyState = 1;
    static instance: Socket;
    sent: any[] = [];
    closed = false;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(public url: URL) {
      Socket.instance = this;
    }
    send(x: string) {
      this.sent.push(JSON.parse(x));
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  let hints = 0,
    fatals = 0;
  const topic = "conduit:pool:shared";
  const transport = await startWakeTransport(
    {
      url: "https://disposable.supabase.co",
      publishableKey: "sb_publishable_fake",
      topic,
      sessionFile,
    },
    () => hints++,
    () => fatals++,
    {
      Socket: Socket as unknown as typeof WebSocket,
      fetcher: async () => {
        throw Error("cached token should not fetch");
      },
    },
  );
  try {
    await new Promise((r) => setImmediate(r));
    const s = Socket.instance;
    s.onopen?.();
    assert.equal(s.url.protocol, "wss:");
    assert.equal(s.sent[0].event, "phx_join");
    assert.equal(s.sent[0].payload.config.private, true);
    assert.equal(s.sent[0].payload.config.presence.enabled, false);
    const event = (m: unknown) => s.onmessage?.({ data: JSON.stringify(m) });
    event({
      topic: "realtime:" + topic,
      event: "phx_reply",
      payload: { status: "ok" },
    });
    assert.equal(hints, 1);
    event({
      topic: "realtime:" + topic,
      event: "broadcast",
      payload: { event: "work_available", payload: { v: 1, command: "run" } },
    });
    assert.equal(hints, 1);
    event({
      topic: "realtime:other",
      event: "broadcast",
      payload: { event: "work_available", payload: { v: 1 } },
    });
    assert.equal(hints, 1);
    event({
      topic: "realtime:" + topic,
      event: "broadcast",
      payload: {
        event: "work_available",
        payload: { v: 1, id: "00000000-0000-4000-8000-000000000001" },
      },
    });
    assert.equal(hints, 2);
    assert.equal(fatals, 0);
  } finally {
    transport.close();
    assert.equal(Socket.instance.closed, true);
    await rm(dir, { recursive: true, force: true });
  }
});
test("four execution slots refill on completion without new hints; active heartbeat retained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-slots-"));
  let next = 0,
    active = 0,
    peak = 0,
    completed = 0,
    stop = false,
    heartbeats = 0;
  const total = 9;
  try {
    await superviseWake({
      stateDir: dir,
      limit: 4,
      gate: new WakeGate(),
      stopping: () => stop,
      wait: async () => {
        await new Promise((r) => setImmediate(r));
      },
      reconcile: async () => {},
      call: async (path, body: any) => {
        if (path === "/api/claim") {
          if (next === total) return { job: null };
          const id = String(++next);
          active++;
          peak = Math.max(peak, active);
          return { job: { id, claim_token: id, task: "simulate-development" } };
        }
        if (path === "/api/heartbeat") {
          heartbeats++;
          return {};
        }
        if (path.endsWith("/report") && body.action === "completed") {
          active--;
          completed++;
          if (completed === total) stop = true;
        }
        return {};
      },
    });
    assert.equal(completed, total);
    assert.equal(peak, 4);
    assert.equal(heartbeats, 45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("recovery barrier reports old journal before reconcile or any new claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-recovery-"));
  const calls: string[] = [];
  let stop = false;
  await writeFile(
    join(dir, "journal-old.json"),
    JSON.stringify({
      job: { id: "old", claim_token: "fence", task: "simulate-development" },
      outcome: { action: "completed", progress: 100, result: {} },
    }),
  );
  try {
    await superviseWake({
      stateDir: dir,
      limit: 4,
      gate: new WakeGate(),
      stopping: () => stop,
      wait: async () => {
        await new Promise((r) => setImmediate(r));
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
      call: async (path) => {
        calls.push(path);
        if (path === "/api/claim") {
          stop = true;
          return { job: null };
        }
        return {};
      },
    });
    assert.deepEqual(calls.slice(0, 3), [
      "/api/jobs/old/report",
      "reconcile",
      "/api/claim",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a completion refills vacant slots even while another slot stays active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wake-refill-"));
  let next = 0,
    stop = false,
    release: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let refilled = false;
  try {
    await superviseWake({
      stateDir: dir,
      limit: 2,
      gate: new WakeGate(),
      stopping: () => stop,
      wait: async () => {
        await new Promise((r) => setImmediate(r));
      },
      reconcile: async () => {},
      call: async (path, body: any) => {
        if (path === "/api/claim") {
          const id = String(++next);
          if (next === 3) {
            refilled = true;
            stop = true;
            release();
            return { job: null };
          }
          return { job: { id, claim_token: id, task: "simulate-development" } };
        }
        if (path === "/api/jobs/1/report" && body.action === "progress")
          await blocked;
        return {};
      },
    });
    assert.equal(refilled, true);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test("idle/active heartbeat and report do not flush outbox or add a DB query", async () => {
  const { mayProduceWake } = await import("../src/lib/wake-api");
  for (const path of [
    "/api/heartbeat",
    "/api/jobs/id/report",
    "/api/jobs/id/publication",
    "/api/agent/event-consumers/id/ack",
  ])
    assert.equal(
      mayProduceWake(
        new Request("https://example.invalid" + path, { method: "POST" }),
      ),
      false,
    );
  for (const path of [
    "/api/jobs",
    "/api/claim",
    "/api/development/reconcile",
    "/api/worker-wake",
    "/api/jobs/id/revisions",
    "/api/jobs/id/retry",
    "/api/initiatives/id/activate",
  ])
    assert.equal(
      mayProduceWake(
        new Request("https://example.invalid" + path, { method: "POST" }),
      ),
      true,
    );
});

test("MissingPartition join retries with cached token; authorization and unknown denials remain fatal", async () => {
  const { startWakeTransport } = await import("../worker/wake-transport");
  const dir = await mkdtemp(join(tmpdir(), "wake-readiness-"));
  const sessionFile = join(dir, "session");
  await writeFile(
    sessionFile,
    JSON.stringify({
      access_token: "cached",
      refresh_token: "r",
      expires_at: Date.now() / 1000 + 3600,
    }),
    { mode: 0o600 },
  );
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(public url: URL) {
      Socket.instances.push(this);
    }
    send() {}
    close() {
      if (this.readyState !== 3) {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    reply(reason?: unknown) {
      this.onmessage?.({
        data: JSON.stringify({
          topic: "realtime:conduit:pool:shared",
          event: "phx_reply",
          payload:
            reason === undefined
              ? { status: "ok" }
              : { status: "error", response: { reason } },
        }),
      });
    }
  }
  let hints = 0,
    fatals = 0,
    refreshes = 0;
  const open = () =>
    startWakeTransport(
      {
        url: "https://disposable.supabase.co",
        publishableKey: "sb_publishable_fake",
        topic: "conduit:pool:shared",
        sessionFile,
      },
      () => hints++,
      () => fatals++,
      {
        Socket: Socket as unknown as typeof WebSocket,
        fetcher: async () => {
          refreshes++;
          throw Error("unexpected refresh");
        },
      },
    );
  let t: Awaited<ReturnType<typeof open>> | undefined;
  try {
    t = await open();
    await new Promise((r) => setImmediate(r));
    const first = Socket.instances[0];
    first.onopen?.();
    first.reply(
      "MissingPartition: Realtime was unable to find the expected messages partition",
    );
    assert.equal(fatals, 0);
    assert.equal(hints, 0);
    assert.equal(first.readyState, 3);
    const deadline = Date.now() + 4000;
    while (Socket.instances.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(Socket.instances.length, 2);
    const second = Socket.instances[1];
    second.onopen?.();
    second.reply();
    assert.equal(hints, 1);
    assert.equal(refreshes, 0);
    t.close();
    for (const reason of [
      "Unauthorized: denied",
      "InvalidJWTToken: expired",
      "other MissingPartition: not the known error",
      "MissingPartition",
      {},
      "UnknownServiceError: fail closed",
    ]) {
      const before = Socket.instances.length;
      t = await open();
      await new Promise((r) => setImmediate(r));
      Socket.instances.at(-1)!.onopen?.();
      Socket.instances.at(-1)!.reply(reason);
      assert.equal(fatals, before - 1);
      assert.equal(Socket.instances.at(-1)!.readyState, 3);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(Socket.instances.length, before + 1);
      t.close();
    }
    // No delayed reconnect from any fatal denial after the first retry window.
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(Socket.instances.length, 8);
    assert.equal(fatals, 6);
    assert.equal(refreshes, 0);
  } finally {
    t?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
