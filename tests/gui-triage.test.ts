import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTriage,
  filterTriage,
  triageFilter,
  needsYou,
  dashboardUrl,
  type Job,
  type Detail,
  type Worker,
} from "../src/gui/model";

const job = (id: string, changes: Partial<Job> = {}): Job => ({
  id,
  title: "Same title",
  status: "failed",
  progress: 0,
  attempt_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  ...changes,
});
const publication: Detail = {
  publication: {
    publication_state: "published",
    updated_at: "2020-01-01",
    pull_request: {
      url: "https://github.com/o/r/pull/1",
      number: 1,
      state: "open",
      draft: false,
      merged: false,
    },
  },
};
const worker: Worker = {
  worker_id: "w",
  available: false,
  busy: false,
  last_seen_at: "invalid",
};
test("latest loaded scope is explicit, deterministic, immutable and date-safe", () => {
  const jobs = [
    job("root", { root_job_id: "root" }),
    job("revision", {
      root_job_id: "root",
      created_at: "2026-11-02",
      status: "completed",
    }),
    job("unrelated", { created_at: "2020-01-01" }),
    job("invalid-z", {
      root_job_id: "root",
      created_at: "invalid",
      attempt_count: 99,
    }),
    job("tie-a", { root_job_id: "tie", created_at: "invalid" }),
    job("tie-z", { root_job_id: "tie", created_at: "invalid" }),
    job("valid", { root_job_id: "valid-root", created_at: "2026-01-01" }),
    job("invalid", { root_job_id: "valid-root", created_at: "invalid" }),
    job("same-time-a", { root_job_id: "same" }),
    job("same-time-z", { root_job_id: "same" }),
  ];
  const original = [...jobs];
  const expected = deriveTriage(jobs);
  assert.deepEqual(
    expected.jobs.map((j) => j.id),
    ["revision", "same-time-z", "valid", "unrelated", "tie-z"],
  );
  for (let offset = 0; offset < jobs.length; offset++) {
    assert.deepEqual(
      deriveTriage([...jobs.slice(offset), ...jobs.slice(0, offset)].reverse()),
      expected,
    );
  }
  assert.deepEqual(jobs, original);
  assert.equal(expected.hidden, 5);
  assert.equal(deriveTriage(jobs, "all").jobs.length, jobs.length);
  assert.deepEqual(deriveTriage(jobs, "invalid"), expected);
  assert.deepEqual(
    needsYou(jobs, [], { root: publication })
      .map((n) => n.job?.id)
      .sort(),
    ["same-time-z", "tie-z", "unrelated", "valid"],
  );
  assert.ok(
    needsYou(jobs, [], { root: publication }, 0, "all").some(
      (n) => n.job?.id === "root",
    ),
  );
});
test("filters compose with search, retain unknown statuses, and use publication evidence", () => {
  const jobs = [
    job("run", { status: "running" }),
    job("wait", { status: "waiting_dependencies" }),
    job("review", { status: "completed" }),
    job("blocked", { status: "blocked" }),
    job("unknown", { status: "future" }),
  ];
  const details = { review: publication };
  for (const [filter, ids] of Object.entries({
    all: ["run", "wait", "review", "blocked", "unknown"],
    running: ["run"],
    waiting: ["wait"],
    review: ["review"],
    failed: ["blocked"],
  }))
    assert.deepEqual(
      filterTriage(jobs, details, triageFilter(filter)).map((j) => j.id),
      ids,
    );
  assert.equal(filterTriage(jobs, details, "review", "REVIEW").length, 1);
  assert.equal(filterTriage(jobs, details, "review", "run").length, 0);
  for (const value of ["invalid", "__proto__", "", null])
    assert.equal(triageFilter(value), "all");
  assert.equal(filterTriage(jobs, {}, "review").length, 0);
  for (const changes of [{ state: "closed" }, { merged: true }]) {
    const closed = structuredClone(publication);
    Object.assign(closed.publication!.pull_request!, changes);
    assert.equal(filterTriage(jobs, { review: closed }, "review").length, 0);
  }
});
test("dependency conditions retain all blocked jobs and waiting alone never warns about workers", () => {
  const a = job("a", {
    status: "waiting_dependencies",
    dependency_job_ids: ["dep", "dep", "missing"],
  });
  const b = job("b", {
    status: "waiting_dependencies",
    dependency_job_ids: ["dep"],
  });
  const dep = job("dep", { status: "completed" });
  const items = needsYou([a, b, dep], [worker], { dep: publication }, 0);
  assert.equal(items.length, 2);
  assert.ok(items.every((n) => n.group === "Dependencies"));
  const condition = items.find((n) => n.url)!;
  assert.equal(condition.relatedJobs?.length, 1);
  assert.deepEqual([condition.job!.id, condition.relatedJobs![0].id].sort(), [
    "a",
    "b",
  ]);
  assert.match(items.find((n) => !n.url)!.why, /unavailable/);
  assert.equal(
    needsYou([job("queued", { status: "queued" })], [worker], {}, 0)[0].group,
    "Worker health",
  );
  assert.match(
    needsYou(
      [job("waiting", { status: "waiting_dependencies" })],
      [worker],
      {},
      0,
    )[0].why,
    /IDs not reported/,
  );
});
test("review snapshots are evidence, not freshness or merge guarantees; failures remain visible during partial reads", () => {
  const j = job("review", { status: "completed" });
  assert.match(
    needsYou([j], [], { review: publication })[0].why,
    /not merge approval/,
  );
  const stale = structuredClone(publication);
  stale.publication!.publication_state = "pending";
  assert.equal(needsYou([j], [], { review: stale }).length, 0);
  assert.equal(
    needsYou([j, job("failure")], [], {
      review: { errors: ["publication failed"] },
    }).length,
    1,
  );
});
test("URL transitions preserve scope, search, direct older-job selection and independent history snapshots", () => {
  const initial =
    "https://conduit.test/app/board?job=older&filter=Same&status=failed";
  const history = [initial];
  history.push(dashboardUrl(history.at(-1)!, "attempts", "all"));
  history.push(dashboardUrl(history.at(-1)!, "status", "review"));
  history.push(dashboardUrl(history.at(-1)!, "job", ""));
  const back = new URL(history[2]);
  assert.equal(back.searchParams.get("job"), "older");
  assert.equal(back.searchParams.get("attempts"), "all");
  assert.equal(back.searchParams.get("filter"), "Same");
  assert.equal(new URL(history[1]).searchParams.get("status"), "failed");
  assert.equal(new URL(history[3]).searchParams.get("job"), null);
  assert.equal(new URL(history[3]).searchParams.get("status"), "review");
  const jobs = [
    job("older"),
    job("newer", { root_job_id: "older", created_at: "2026-11-02" }),
  ];
  assert.equal(
    deriveTriage(jobs).jobs.some((j) => j.id === "older"),
    false,
  );
  assert.equal(
    jobs.find((j) => j.id === back.searchParams.get("job"))?.id,
    "older",
  );
});
