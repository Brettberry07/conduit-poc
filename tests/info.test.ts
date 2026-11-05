import { test } from "node:test";
import assert from "node:assert/strict";
import { info } from "../src/lib/info";
import { SCOPES, credentialScopes } from "../src/lib/keys";

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
    "POST /api/jobs",
    "GET /api/jobs/{id}",
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
  ];
  assert.deepEqual([...payload.endpoints].sort(), expected.sort());
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
      const content = body
        .match(/<pre[^>]*>([\s\S]*?)<\/pre>/)![1]
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      assert.deepEqual(JSON.parse(content), json);
    } else {
      assert.deepEqual(await response.json(), json);
    }
  }
});
