import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  allowedScopes,
  credentialScopes,
  type Scope,
  type Identity,
} from "../src/lib/keys";
import { authenticateConsole } from "../src/lib/auth";
import { handle } from "../src/lib/api";
import { initiativeApi } from "../src/lib/initiative-api";
import { OwnerActions } from "../src/gui/client";
import type { DB } from "../src/lib/db";

const id = "9b56ae7e-8d6b-44d2-be89-0903e9c6b820";
// Frozen pre-change scopes, including routes the console must never acquire.
const routes: [string, string, Scope][] = [
  ["GET", "/api/jobs", "jobs:read"],
  ["POST", "/api/jobs", "jobs:create"],
  ["GET", "/api/jobs/id", "jobs:read"],
  ["GET", "/api/workers", "jobs:read"],
  ["POST", "/api/claim", "jobs:claim"],
  ["POST", "/api/heartbeat", "jobs:update"],
  ["POST", "/api/jobs/id/report", "jobs:update"],
  ...["retry", "revisions"].map(
    (op) =>
      ["POST", `/api/jobs/id/${op}`, "jobs:revise"] as [string, string, Scope],
  ),
  ...["revisions", "executions", "changes", "diff", "publication"].map(
    (op) =>
      ["GET", `/api/jobs/id/${op}`, "jobs:read"] as [string, string, Scope],
  ),
  ...["publication", "artifacts"].map(
    (op) =>
      ["POST", `/api/jobs/id/${op}`, "jobs:update"] as [string, string, Scope],
  ),
  ...["pending", "reconcile"].map(
    (op) =>
      ["POST", `/api/development/${op}`, "jobs:update"] as [
        string,
        string,
        Scope,
      ],
  ),
  ...["manifest", "monitor", "events", "event-consumers/name"].map(
    (op) => ["GET", `/api/agent/${op}`, "jobs:read"] as [string, string, Scope],
  ),
  ["POST", "/api/agent/event-consumers/name/ack", "jobs:revise"],
  ["GET", "/api/projects", "jobs:read"],
  ["GET", "/api/projects/id", "jobs:read"],
  ...["", "/id", "/id/plan", "/id/resume", "/id/reviews"].map(
    (op) =>
      ["GET", `/api/initiatives${op}`, "jobs:read"] as [string, string, Scope],
  ),
  ["POST", "/api/initiatives", "jobs:create"],
  ["POST", "/api/initiatives/id/activate", "jobs:create"],
  ["PATCH", "/api/initiatives/id", "jobs:revise"],
  ["PATCH", "/api/initiatives/id/plan", "jobs:revise"],
  ["POST", "/api/initiatives/id/reviews", "jobs:revise"],
];
test("scope matrix: console grants exactly four routes, API-key decisions unchanged", () => {
  const additions = new Map([
    ["POST /api/jobs", "console:create"],
    ["POST /api/jobs/id/retry", "console:action"],
    ["POST /api/jobs/id/revisions", "console:action"],
    ["PATCH /api/initiatives/id", "console:action"],
  ]);
  for (const [method, path, old] of routes) {
    const extra = additions.get(`${method} ${path}`);
    assert.deepEqual(allowedScopes(path, method), extra ? [old, extra] : [old]);
    for (const scope of ["console:action", "console:create"] as const)
      assert.equal(
        allowedScopes(path, method).includes(scope),
        extra === scope,
        `${scope}: ${method} ${path}`,
      );
    for (const scopes of Object.values(credentialScopes))
      assert.equal(
        allowedScopes(path, method).some((s) =>
          (scopes as readonly string[]).includes(s),
        ),
        (scopes as readonly string[]).includes(old),
      );
    for (const other of ["DELETE", "PUT", "OPTIONS"])
      assert.deepEqual(allowedScopes(path, other), []);
  }
  for (const path of new Set(routes.map(([, path]) => path)))
    for (const method of [
      "GET",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ])
      for (const scope of ["console:action", "console:create"] as const)
        assert.equal(
          allowedScopes(path, method).includes(scope),
          additions.get(`${method} ${path}`) === scope,
          `${method} ${path}: ${scope}`,
        );
  assert.deepEqual(allowedScopes("/api/console/identity", "GET"), [
    "jobs:read",
  ]);
  for (const path of [
    "/api/settings",
    "/api/jobs/id/merge",
    "/api/console/identity",
    "/api/unknown",
  ])
    assert.deepEqual(allowedScopes(path, "POST"), []);
});

test("console scopes bind only to verified allowlisted sub; unlinked stays denied", async () => {
  const db: DB = {
    async query(_sql, args) {
      return {
        rows: args?.[0] === "unlinked" ? [] : [{ principal: "same-owner" }],
        rowCount: 1,
      };
    },
  };
  for (const sub of [
    id,
    "12345678-1234-4234-8234-123456789abc",
    "00000000-0000-4000-8000-000000000000",
  ]) {
    const identity = await authenticateConsole(
      db,
      "Bearer jwt",
      "https://auth.test",
      async () => sub,
    );
    assert.ok(identity && identity !== "unlinked");
    assert.deepEqual(
      identity.scopes,
      sub === id
        ? ["jobs:read", "console:action", "console:create"]
        : ["jobs:read"],
    );
    if (sub !== id)
      for (const [method, path] of routes.filter(([m]) => m !== "GET"))
        assert.equal(
          allowedScopes(path, method).some((s) => identity.scopes.includes(s)),
          false,
        );
  }
  assert.equal(
    await authenticateConsole(
      db,
      "Bearer jwt",
      "https://auth.test",
      async () => "unlinked",
    ),
    "unlinked",
  );
  assert.equal(
    await authenticateConsole(
      db,
      "Bearer jwt",
      "https://auth.test",
      async () => null,
    ),
    null,
  );
  for (const [role, scopes] of Object.entries(credentialScopes)) {
    const original = {
      principal: "key-owner",
      scopes: [...scopes],
      role: role === "worker" ? "worker" : "submitter",
      id: "key-id",
    };
    const keyDb: DB = {
      async query() {
        return { rows: [original], rowCount: 1 };
      },
    };
    assert.equal(
      JSON.stringify(
        await authenticateConsole(
          keyDb,
          `Bearer cnd_live_${"a".repeat(43)}`,
          "https://auth.test",
          async () => {
            throw Error("must not verify API key");
          },
        ),
      ),
      JSON.stringify(original),
    );
    const response = await handle(
      new Request("https://test/api/console/identity", {
        headers: { Authorization: `Bearer cnd_live_${"a".repeat(43)}` },
      }),
      keyDb,
    );
    assert.equal(response.status, role === "worker" ? 403 : 200);
    if (response.ok) assert.deepEqual(await response.json(), { scopes });
  }
});

test("console lifecycle allows pause/resume/cancel, forbids completion before DB access", async () => {
  const identity: Identity = {
    id,
    principal: "owner",
    role: "submitter",
    scopes: ["jobs:read", "console:action"],
  };
  for (const [before, status] of [
    ["active", "paused"],
    ["paused", "active"],
    ["active", "cancelled"],
    ["paused", "cancelled"],
    ["active", "completed"],
  ]) {
    let queries = 0;
    const connection = {
      release() {},
      async query(sql: string, args?: unknown[]) {
        queries++;
        if (sql.startsWith("SELECT * FROM orchestrator.initiatives"))
          return {
            rows: [
              {
                id,
                status: before,
                activated_at: "now",
                project_id: id,
                plan: { base_branch: "main" },
              },
            ],
            rowCount: 1,
          };
        if (sql.includes("FROM orchestrator.projects"))
          return {
            rows: [{ default_branch: "main", allowed_base_branches: ["main"] }],
            rowCount: 1,
          };
        return { rows: [{ id, status: args?.[1] }], rowCount: 1 };
      },
    };
    const db = {
      ...connection,
      async connect() {
        return connection;
      },
    };
    const response = await initiativeApi(
      new Request(`https://test/api/initiatives/${id}`, { method: "PATCH" }),
      db,
      identity,
      async () => ({ expected_status: before, status }),
    );
    assert.equal(response?.status, status === "completed" ? 403 : 200);
    if (status === "completed") assert.equal(queries, 0);
    else assert.equal((await response!.json()).initiative.status, status);
  }
});

test("six action types render only with matching identity scope and eligible state", () => {
  const job = {
    id,
    title: "Example",
    status: "failed",
    progress: 0,
    attempt_count: 1,
    created_at: "now",
  };
  const publication = {
    publication_state: "published",
    pull_request: {
      url: "https://github.com/a/b/pull/1",
      number: 1,
      state: "open",
      draft: true,
      merged: false,
    },
  };
  const props = { job, publication, write: async () => {} };
  const render = (scopes: string[], extra = {}) =>
    renderToStaticMarkup(createElement(OwnerActions, { scopes, ...extra }));
  assert.equal(render([], props), "");
  assert.equal(render(["jobs:read", "jobs:revise", "jobs:create"], props), "");
  const actions = render(["console:action"], props);
  assert.match(actions, />Retry</);
  assert.match(actions, />Request revision</);
  assert.match(actions, /Revision instructions/);
  assert.doesNotMatch(
    render(["console:create"], props),
    />Retry<|Request revision/,
  );
  for (const status of ["running", "completed", "queued"])
    assert.doesNotMatch(
      render(["console:action"], {
        ...props,
        job: { ...job, status },
        publication: null,
      }),
      /<button/,
    );
  for (const pr of [
    { ...publication.pull_request, state: "closed" },
    { ...publication.pull_request, draft: false },
    { ...publication.pull_request, merged: true },
  ])
    assert.doesNotMatch(
      render(["console:action"], {
        ...props,
        publication: { ...publication, pull_request: pr },
      }),
      /Request revision/,
    );
  const initiatives = [
    "active",
    "paused",
    "completed",
    "cancelled",
    "draft",
  ].map((status) => ({ id: status, title: status, status }));
  const lifecycle = render(["console:action"], { initiatives });
  assert.match(lifecycle, />Pause</);
  assert.match(lifecycle, />Resume</);
  assert.equal((lifecycle.match(/>Cancel</g) ?? []).length, 2);
  assert.doesNotMatch(lifecycle, /Create job|>completed<|>cancelled<|>draft</);
  const create = render(["console:create"], {
    initiatives,
    projects: [{ id, name: "Project" }],
  });
  assert.match(create, /Job title/);
  assert.match(create, /Job instructions/);
  assert.match(create, /disabled="">Create job/);
  assert.doesNotMatch(create, />Pause<|>Resume<|>Cancel<|Merge/);
});
