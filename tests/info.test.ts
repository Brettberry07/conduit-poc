import { test } from "node:test";
import assert from "node:assert/strict";
import { info } from "../src/lib/info";
import { SCOPES, credentialScopes, allowedScopes } from "../src/lib/keys";

test("public info describes implemented capabilities without runtime details", async () => {
  const response = info(new Request("https://example.test/info"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  const payload = await response.json();
  assert.deepEqual(payload.authentication.scopes, [...SCOPES]);
  assert.deepEqual(payload.authentication.credential_scopes, credentialScopes);
  assert.deepEqual(payload.task_types, [
    "simulate-development",
    "simulate-failure",
    "codex_task",
    "development",
  ]);
  const expected = [
    "GET /",
    "GET /info",
    "GET /health",
    "GET /auth-check",
    "GET /api/jobs",
    "GET /api/agent/manifest",
    "GET /api/agent/events",
    "GET /api/agent/event-consumers/{name}",
    "POST /api/agent/event-consumers/{name}/ack",
    "POST /api/jobs",
    "GET /api/jobs/{id}",
    "POST /api/jobs/{id}/retry",
    "GET /api/workers",
    "POST /api/claim",
    "POST /api/heartbeat",
    "POST /api/jobs/{id}/report",
    "GET /api/projects",
    "GET /api/projects/{id}",
    "POST /api/jobs/{id}/artifacts",
    "POST /api/development/pending",
    "POST /api/development/reconcile",
    ...["revisions", "executions", "changes", "diff", "publication"].map(
      (operation) => `GET /api/jobs/{id}/${operation}`,
    ),
    "POST /api/jobs/{id}/revisions",
    "POST /api/jobs/{id}/publication",
    "GET /api/initiatives",
    "POST /api/initiatives",
    "GET /api/initiatives/{id}",
    "PATCH /api/initiatives/{id}",
    "GET /api/initiatives/{id}/plan",
    "PATCH /api/initiatives/{id}/plan",
    "POST /api/initiatives/{id}/activate",
    "GET /api/initiatives/{id}/resume",
    "GET /api/initiatives/{id}/reviews",
    "POST /api/initiatives/{id}/reviews",
  ];
  assert.deepEqual(
    payload.endpoints
      .map((entry: { endpoint: string }) => entry.endpoint)
      .sort(),
    expected.sort(),
  );
  assert.deepEqual(
    payload.endpoints
      .filter(
        (entry: { required_access: string }) =>
          entry.required_access === "public",
      )
      .map((entry: { endpoint: string }) => entry.endpoint)
      .sort(),
    ["GET /", "GET /info", "GET /health"].sort(),
  );
  for (const entry of payload.endpoints) {
    assert.equal(typeof entry.required_access, "string");
    assert.ok(entry.required_access.length > 0);
    const [method, path] = entry.endpoint.split(" ");
    const scope = allowedScopes(path, method)[0];
    if (scope)
      assert.equal(
        entry.required_access,
        "Bearer " +
          (scope === "jobs:claim" || scope === "jobs:update"
            ? "worker-only"
            : "Instinct") +
          " credential: " +
          scope,
      );
    if (entry.endpoint === "GET /auth-check")
      assert.equal(entry.required_access, "Bearer key");
  }
  assert.match(
    payload.authentication.description,
    /No single credential can use every endpoint/,
  );
  assert.ok(
    payload.authentication.description.includes(
      "GET /auth-check requires a Bearer key",
    ),
  );
  assert.deepEqual(payload.limitations, [
    "The worker sandbox has no network access.",
    "The repository full test suite cannot run inside the sandbox.",
    "Configured verification is a bounded subset of the full suite.",
  ]);
  assert.match(payload.descriptor_status, /static, built from the code/);
  assert.match(
    payload.descriptor_status,
    /does not prove current worker availability/,
  );
  assert.ok(
    payload.descriptor_status.includes(
      "GET /api/workers for live worker readiness",
    ),
  );
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /cnd_live_|\/(?:Users|home|private|tmp|var|etc)\/|[A-Z]:\\/i,
  );
  assert.doesNotMatch(
    serialized,
    /localhost|127\.0\.0\.1|hostname|worker_id|project_id|process\.env|DATABASE_URL|key_prefix|key_hash/i,
  );
});

test("HTML preference renders the same descriptor and varies by Accept", async () => {
  const json = await info(new Request("https://example.test/info")).json();
  for (const [accept, html] of [
    ["text/html", true],
    ["application/json;q=0.5, text/html;q=0.9", true],
    ["text/html;q=0.2, application/json", false],
    ["text/html;q=0, */*;q=1", false],
    ["*/*", false],
    ["text/html, application/json", false],
  ] as const) {
    const response = info(
      new Request("https://example.test/info", { headers: { Accept: accept } }),
    );
    assert.equal(response.headers.get("vary"), "Accept");
    if (html) {
      assert.match(response.headers.get("content-type")!, /text\/html/);
      const body = await response.text();
      assert.ok(body.includes("<h1>Conduit capabilities</h1>"));
      assert.ok(body.includes("<ul>"));
      assert.ok(body.includes("<table>"));
      assert.ok(!body.includes("<pre"));
      for (const entry of json.endpoints) {
        assert.ok(body.includes(entry.endpoint));
        assert.ok(body.includes(entry.required_access));
      }
      for (const limitation of json.limitations)
        assert.ok(body.includes(limitation));
      assert.ok(body.includes(json.descriptor_status));
      assert.doesNotMatch(
        body,
        /cnd_live_|\/(?:Users|home|private|tmp|var|etc)\/|[A-Z]:\\/i,
      );
      assert.doesNotMatch(
        body,
        /localhost|127\.0\.0\.1|hostname|worker_id|project_id|process\.env|DATABASE_URL|key_prefix|key_hash/i,
      );
    } else {
      assert.deepEqual(await response.json(), json);
    }
  }
});
