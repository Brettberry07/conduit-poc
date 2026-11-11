import { test } from "node:test";
import assert from "node:assert/strict";
import { readApi } from "../src/gui/auth";
test("owner dashboard reads pass the exact client GET allowlist", async () => {
  const paths = [
    "/api/console/identity",
    "/api/initiatives",
    "/api/projects",
    "/api/agent/manifest",
  ];
  const calls: string[] = [];
  const read = (path: string) =>
    readApi(
      path,
      "owner-key",
      new AbortController().signal,
      async (actual, init, token) => {
        calls.push(actual);
        assert.equal(init.method, "GET");
        assert.equal(token, "owner-key");
        return Response.json({ ok: true });
      },
    );
  for (const path of paths) assert.deepEqual(await read(path), { ok: true });
  for (const path of [
    "/api/admin",
    ...paths.flatMap((path) => [path + "/extra", path + "?extra=1"]),
  ]) {
    await assert.rejects(read(path), /Unsupported read/);
  }
  assert.deepEqual(calls, paths);
});
import {
  column,
  dependencyLabel,
  githubUrl,
  needsYou,
  stale,
  type Job,
  type Worker,
  type Detail,
} from "../src/gui/model";
const job = (v: Partial<Job> = {}): Job => ({
  id: "job-a",
  title: "A",
  status: "queued",
  progress: 0,
  attempt_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  ...v,
});
test("terminal failures stay separate and dependencies stay queued", () => {
  assert.equal(column("completed"), "Completed");
  for (const s of ["failed", "blocked"])
    assert.equal(column(s), "Failed / blocked");
  assert.equal(column("waiting_dependencies"), "Queued");
  assert.match(
    dependencyLabel(job({ dependency_job_ids: ["a", "b"] })),
    /Waiting on 2 job\(s\): a, b/,
  );
  assert.equal(column("new-status"), "Unknown status");
});
test("worker staleness has a 15 second boundary", () => {
  const w: Worker = {
    worker_id: "w",
    available: true,
    busy: false,
    last_seen_at: "2026-01-01T00:00:00Z",
  };
  const t = Date.parse(w.last_seen_at);
  assert.equal(stale(w, t + 15000), false);
  assert.equal(stale(w, t + 15001), true);
  assert.equal(stale({ ...w, last_seen_at: "invalid" }, t), true);
});
test("GitHub links reject alternate origins and credentials", () => {
  assert.equal(
    githubUrl("https://github.com/org/repo/pull/1"),
    "https://github.com/org/repo/pull/1",
  );
  for (const url of [
    "http://github.com/a",
    "https://github.com.evil.test/a",
    "javascript:alert(1)",
    "https://github.com@evil.test/a",
    "https://user@github.com/a",
    "https://github.com:444/a",
    "/local",
  ])
    assert.equal(githubUrl(url), undefined);
});
test("needs-you is evidence-based, ordered and read-only", () => {
  const jobs = [
    job({ id: "failed", status: "failed", error: "Build failed" }),
    job({ id: "recover", result: { recovery_required: true } }),
    job({
      id: "wait",
      status: "waiting_dependencies",
      dependency_job_ids: ["dep"],
    }),
  ];
  const details: Record<string, Detail> = {
    dep: {
      publication: {
        publication_state: "published",
        pull_request: {
          url: "https://github.com/o/r/pull/7",
          number: 7,
          state: "open",
          draft: true,
          merged: false,
        },
      },
    },
  };
  const items = needsYou(jobs, [], details);
  assert.equal(items[0].severity, 0);
  assert.ok(
    items.some(
      (i) =>
        i.command === "npm run development:admin -- inspect --job-id recover",
    ),
  );
  assert.ok(items.some((i) => i.why.includes("review PR #7")));
  assert.ok(items.some((i) => i.why.includes("Build failed")));
  assert.deepEqual(needsYou([job()], [], {}), []);
  details.dep.publication!.pull_request!.merged = true;
  assert.ok(
    !needsYou(jobs, [], details).some((i) => i.why.includes("review PR")),
  );
});
test("draft review is deduplicated by root and offline workers require queue", () => {
  const p: Detail = {
    publication: {
      publication_state: "published",
      pull_request: {
        url: "https://github.com/o/r/pull/1",
        number: 1,
        state: "open",
        draft: true,
        merged: false,
      },
    },
  };
  const a = job({ id: "root", status: "completed" }),
    b = job({ id: "rev", root_job_id: "root", status: "completed" });
  assert.equal(needsYou([a, b], [], { root: p, rev: p }).length, 1);
  const w: Worker = {
    worker_id: "w",
    last_seen_at: "2020-01-01",
    available: false,
    busy: false,
  };
  assert.equal(needsYou([a], [w], {}).length, 0);
  assert.equal(needsYou([job()], [w], {}).length, 1);
});

test("the console reads exact job history through its same-origin GET allowlist", async () => {
  const path =
    "/api/agent/events?job_id=11111111-1111-4111-8111-111111111111&limit=20";
  const signal = new AbortController().signal;
  const read = (url: string) =>
    readApi(url, "test-viewer", signal, async (actual, init) => {
      assert.equal(actual, path);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, { Authorization: "Bearer test-viewer" });
      return Response.json({ events: [] });
    });
  assert.deepEqual(await read(path), { events: [] });
  await assert.rejects(
    read("/api/agent/event-consumers/viewer/ack"),
    /Unsupported read/,
  );
  await assert.rejects(read(path + "&after=0"), /Unsupported read/);
});
