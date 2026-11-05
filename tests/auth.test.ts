import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { jwtVerifier, authenticateConsole } from "../src/lib/auth";
import { handle } from "../src/lib/api";
import {
  authRequest,
  connectEmail,
  readApi,
  sessionClient,
  sessionKey,
} from "../src/gui/auth";
import { hashKey } from "../src/lib/keys";
import type { DB } from "../src/lib/db";
const base = "https://auth.example.test";
const sub = "12345678-1234-4234-8234-123456789abc";
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
function token(
  overrides: Record<string, unknown> = {},
  key = privateKey,
  header = { alg: "ES256", kid: "test" },
) {
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const data =
    encode(header) +
    "." +
    encode({
      sub,
      exp: Date.now() / 1000 + 300,
      iss: base + "/auth/v1",
      aud: "authenticated",
      ...overrides,
    });
  return (
    data +
    "." +
    sign("sha256", Buffer.from(data), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url")
  );
}
function verifier() {
  let calls = 0;
  const verify = jwtVerifier(async (url) => {
    calls++;
    assert.equal(url, base + "/auth/v1/.well-known/jwks.json");
    return Response.json({
      keys: [
        { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "ES256" },
      ],
    });
  });
  return { verify, calls: () => calls };
}
test("ES256 validates signature, expiry, issuer, audience and UUID; caches JWKS", async () => {
  const { verify, calls } = verifier();
  assert.equal(await verify(token(), base), sub);
  assert.equal(await verify(token(), base), sub);
  assert.equal(calls(), 1);
  for (const payload of [
    { exp: Date.now() / 1000 - 1 },
    { iss: "https://wrong.test/auth/v1" },
    { aud: "anon" },
    { aud: ["authenticated"] },
    { sub: "email@example.test" },
    { exp: "tomorrow" },
    { nbf: Date.now() / 1000 + 3600 },
    { nbf: "tomorrow" },
    { nbf: null },
  ])
    assert.equal(await verify(token(payload), base), null);
  assert.equal(await verify(token({ nbf: Date.now() / 1000 - 1 }), base), sub);
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(await verify(token({}, other.privateKey), base), null);
  assert.equal(
    await verify(token({}, privateKey, { alg: "HS256", kid: "test" }), base),
    null,
  );
  assert.equal(await verify("invalid", base), null);
});
test("mapping uses verified UUID only and grants exactly read access", async () => {
  const db: DB = {
    async query(sql, args) {
      assert.equal(
        sql,
        "SELECT principal FROM orchestrator.auth_users WHERE auth_user_id=$1",
      );
      assert.deepEqual(args, [sub]);
      return { rows: [{ principal: "workspace-x" }], rowCount: 1 };
    },
  };
  const { verify } = verifier();
  assert.deepEqual(
    await authenticateConsole(db, "Bearer " + token(), base, verify),
    {
      principal: "workspace-x",
      scopes: ["jobs:read"],
      role: "submitter",
      id: sub,
    },
  );
  const empty: DB = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
  assert.equal(
    await authenticateConsole(empty, "Bearer " + token(), base, verify),
    "unlinked",
  );
});
test("unlinked JWT returns 403 before any job query", async () => {
  const old = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  globalThis.fetch = async () =>
    Response.json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test" }],
    });
  try {
    let queries = 0;
    const db: DB = {
      async query(sql) {
        queries++;
        assert.match(sql, /^SELECT principal FROM orchestrator.auth_users/);
        return { rows: [], rowCount: 0 };
      },
    };
    const premature = await handle(
      new Request("https://console.test/api/jobs", {
        headers: {
          Authorization: "Bearer " + token({ nbf: Date.now() / 1000 + 3600 }),
        },
      }),
      db,
    );
    assert.equal(premature.status, 401);
    assert.equal(queries, 0);
    const response = await handle(
      new Request("https://console.test/api/jobs", {
        headers: { Authorization: "Bearer " + token() },
      }),
      db,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "account not linked" });
    assert.equal(queries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = old;
  }
});
test("existing key delegates unchanged; disabled JWT never queries", async () => {
  const key = "cnd_live_" + "a".repeat(43);
  const identity = {
    principal: "original",
    scopes: ["jobs:read"],
    role: "submitter",
    id: sub,
  };
  const db: DB = {
    async query(sql, args) {
      assert.equal(sql, "SELECT * FROM orchestrator.authenticate_api_key($1)");
      assert.deepEqual(args, [hashKey(key)]);
      return { rows: [identity], rowCount: 1 };
    },
  };
  assert.deepEqual(
    await authenticateConsole(db, "Bearer " + key, ""),
    identity,
  );
  assert.equal(await authenticateConsole(db, "Bearer " + token(), ""), null);
});
test("GoTrue builder uses publishable configuration and tolerates absent env", () => {
  const env = { url: base + "/", key: "public-anon" };
  for (const action of [
    "signup",
    "password",
    "refresh_token",
    "logout",
  ] as const) {
    const request = authRequest(
      action,
      { email: "a@example.test", password: "password" },
      "access",
      env,
    )!;
    assert.equal(
      request.url,
      base +
        "/auth/v1/" +
        (["signup", "logout"].includes(action)
          ? action
          : "token?grant_type=" + action),
    );
    assert.equal(request.init.method, "POST");
    assert.deepEqual(request.init.headers, {
      apikey: "public-anon",
      "Content-Type": "application/json",
      Authorization: "Bearer access",
    });
    assert.deepEqual(JSON.parse(request.init.body), {
      email: "a@example.test",
      password: "password",
    });
  }
  assert.equal(
    authRequest("password", {}, undefined, { url: undefined, key: undefined }),
    null,
  );
  assert.equal(
    authRequest("signup", {}, undefined, { url: base, key: undefined }),
    null,
  );
});

test("linked JWT reads only the mapped principal and cannot mutate", async () => {
  const old = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  globalThis.fetch = async () =>
    Response.json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test" }],
    });
  try {
    const db: DB = {
      async query(sql, args) {
        if (sql.startsWith("SELECT principal"))
          return { rows: [{ principal: "workspace-x" }], rowCount: 1 };
        assert.match(sql, /submitter_id/);
        assert.ok(args?.includes("workspace-x"));
        return { rows: [], rowCount: 0 };
      },
    };
    const headers = { Authorization: "Bearer " + token() };
    const response = await handle(
      new Request("https://console.test/api/jobs", { headers }),
      db,
    );
    assert.equal(response.status, 200);
    for (const path of [
      "/api/jobs",
      "/api/claim",
      "/api/jobs/" + sub + "/revisions",
      "/api/jobs/" + sub + "/report",
    ]) {
      assert.equal(
        (
          await handle(
            new Request("https://console.test" + path, {
              method: "POST",
              headers,
            }),
            db,
          )
        ).status,
        403,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = old;
  }
});

test("stored sessions restore, refresh once across concurrent reads, and clear on failure/logout", async () => {
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon";
  try {
    const session = {
      access_token: "old",
      refresh_token: "refresh",
      user: { id: sub },
    };
    store.set(sessionKey, JSON.stringify(session));
    const changes: unknown[] = [];
    const client = sessionClient((value) => changes.push(value));
    client.restore();
    assert.deepEqual(changes, [session]);
    let refreshes = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("grant_type=refresh_token")) {
        refreshes++;
        assert.deepEqual(JSON.parse(init!.body as string), {
          refresh_token: "refresh",
        });
        return Response.json({ ...session, access_token: "new" });
      }
      return new Response(null, {
        status:
          new Headers(init?.headers).get("Authorization") === "Bearer new"
            ? 200
            : 401,
      });
    };
    const init = { headers: { Authorization: "Bearer old" } };
    const responses = await Promise.all([
      client.fetch("/api/jobs", init, "old"),
      client.fetch("/api/workers", init, "old"),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(refreshes, 1);
    assert.equal(JSON.parse(store.get(sessionKey)!).access_token, "new");
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await client.fetch(
      "/api/jobs",
      { headers: { Authorization: "Bearer new" } },
      "new",
    );
    assert.equal(store.has(sessionKey), false);
    assert.equal(changes.at(-1), null);
    client.save(session);
    await assert.rejects(client.logout());
    assert.equal(store.has(sessionKey), false);
    assert.equal(changes.at(-1), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
  }
});

test("unknown kids share one JWKS fetch per window, including concurrent misses", async (t) => {
  t.mock.method(Date, "now", () => 1800000000000);
  const { verify, calls } = verifier();
  const miss = (kid: string) =>
    verify(token({}, privateKey, { alg: "ES256", kid }), base);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => miss("unknown-" + i)),
    ),
    Array(10).fill(null),
  );
  for (let i = 0; i < 10; i++) assert.equal(await miss("other-" + i), null);
  assert.equal(calls(), 1);
  assert.equal(await verify(token(), base), sub);
  t.mock.method(Date, "now", () => 1800000300001);
  assert.equal(await miss("rotated"), null);
  assert.equal(calls(), 2);
});
test("JWKS streamed body is capped before parsing even without Content-Length", async () => {
  let cancelled = false;
  let calls = 0;
  const verify = jwtVerifier(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          const valid = JSON.stringify({
            keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test" }],
          });
          controller.enqueue(new TextEncoder().encode(valid));
          controller.enqueue(new Uint8Array(65536).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  assert.equal(await verify(token(), base), null);
  assert.equal(cancelled, true);
  assert.equal(await verify(token(), base), null);
  assert.equal(calls, 1);
});

test("connect states: confirmation, generic credentials, unlinked account, and sign-out clearing", async (t) => {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon";
  const store = new Map<string, string>();
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  try {
    const changes: unknown[] = [];
    const client = sessionClient((session) => changes.push(session));
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ user: { id: sub } }),
    );
    assert.equal(
      await connectEmail("signup", "a@example.test", "secret", client.save),
      "Check your email to confirm your account, then sign in.",
    );
    assert.deepEqual(changes, []);
    assert.equal(store.size, 0);
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ error: "sensitive upstream details" }, { status: 400 }),
    );
    await assert.rejects(
      connectEmail("password", "a@example.test", "wrong", client.save),
      {
        message:
          "Authentication failed. Check your credentials and email confirmation.",
      },
    );
    assert.deepEqual(changes, []);
    const session = {
      access_token: "access",
      refresh_token: "refresh",
      user: { id: sub },
    };
    fetchMock.mock.mockImplementation(async () => Response.json(session));
    assert.equal(
      await connectEmail("password", "a@example.test", "secret", client.save),
      "",
    );
    assert.equal(store.has(sessionKey), true);
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ error: "account not linked" }, { status: 403 }),
    );
    await assert.rejects(
      readApi(
        "/api/jobs",
        "access",
        new AbortController().signal,
        client.fetch,
      ),
      { message: "This account isn't linked to any Conduit workspace yet." },
    );
    fetchMock.mock.mockImplementation(
      async () => new Response(null, { status: 204 }),
    );
    await client.logout();
    assert.equal(store.has(sessionKey), false);
    assert.equal(changes.at(-1), null);
  } finally {
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
  }
});
