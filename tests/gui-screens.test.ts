import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleContext, Screen, type ConsoleData } from "../src/gui/client";

const now = Date.parse("2026-11-07T18:00:00Z");
const data: ConsoleData = {
  jobs: ["queued", "running", "completed", "failed", "blocked"].map(
    (status, index) => ({
      id: `1234567${index}-1111-4111-8111-111111111111`,
      title: [
        "Add workspace audit history",
        "Rebuild console navigation",
        "Improve worker recovery",
        "Validate release checks",
        "Publish dependent changes",
      ][index],
      status,
      progress: status === "running" ? 42 : 0,
      attempt_count: 1,
      created_at: "2026-11-07T17:55:00Z",
      worker_id: status === "running" ? "mac-worker" : null,
      error: status === "failed" ? "Release check failed" : null,
    }),
  ),
  workers: [
    {
      worker_id: "mac-worker",
      available: true,
      busy: true,
      last_seen_at: new Date(now).toISOString(),
    },
  ],
  details: {
    "12345672-1111-4111-8111-111111111111": {
      publication: {
        publication_state: "published",
        pull_request: {
          url: "https://github.com/example/conduit/pull/42",
          number: 42,
          state: "open",
          draft: true,
          merged: false,
        },
      },
    },
  },
  now,
  updated: now,
  loading: false,
  paused: false,
  error: "",
  search: "",
  select: () => {},
  setSearch: () => {},
};
function render(view: string, changes: Partial<ConsoleData> = {}) {
  return renderToStaticMarkup(
    createElement(
      ConsoleContext.Provider,
      { value: { ...data, ...changes } },
      createElement(Screen, { view }),
    ),
  );
}
test("board presents compact jobs with distinct SVG status badges and relative times", () => {
  const html = render("board");
  for (const status of ["queued", "running", "review", "failed", "blocked"]) {
    assert.match(html, new RegExp(`status-${status}[^>]*><svg`));
  }
  assert.match(html, /Awaiting review/);
  assert.match(html, /12345670/);
  assert.match(html, /5m ago/);
  assert.doesNotMatch(html, /class="dot|Root job|Claimed/);
  assert.match(render("board", { search: "no match" }), /No matching jobs/);
  assert.match(render("board", { details: {} }), /status-completed/);
});
test("all screens distinguish initial loading, hidden pause, failure and successful empty data", () => {
  for (const view of ["board", "active", "needs-you"]) {
    const loading = render(view, { updated: 0, loading: true });
    assert.match(loading, /aria-busy="true"/);
    assert.doesNotMatch(loading, /Workspace could not be loaded|skeleton-card/);
    const paused = render(view, { updated: 0, paused: true });
    assert.match(paused, /Updates paused/);
    assert.doesNotMatch(paused, /Workspace could not be loaded/);
    assert.match(
      render(view, { updated: 0, error: "Network unavailable" }),
      /Workspace could not be loaded/,
    );
    const empty = render(view, { jobs: [], workers: [], details: {} });
    assert.doesNotMatch(empty, /Workspace could not be loaded|Updates paused/);
    assert.match(
      empty,
      /No jobs in this stage|No workers reported|You are all caught up/,
    );
  }
});
test("monitoring retains real worker and review evidence", () => {
  assert.match(render("active"), /mac-worker/);
  assert.match(render("active"), /42%/);
  assert.match(render("needs-you"), /Draft PR #42/);
  assert.match(render("needs-you"), /Release check failed/);
  assert.match(
    render("needs-you", { jobs: [], workers: [], error: "Partial failure" }),
    /Review signals may be incomplete/,
  );
});

for (const status of ["blocked", "failed"]) {
  test(`needs-you renders the ${status} job badge`, () => {
    const job = data.jobs.find((job) => job.status === status)!;
    const html = render("needs-you", { jobs: [job], workers: [], details: {} });
    const label = status;
    assert.match(html, new RegExp(`status-${status}[^>]*><svg`));
    assert.match(html, new RegExp(`</svg>${label}</span>`));
    if (status === "blocked") {
      assert.doesNotMatch(html, /status-failed|>failed<\/span>/i);
    }
  });
}

for (const signal of ["offline", "stale"]) {
  test(`needs-you renders a neutral worker-health badge for ${signal} workers`, () => {
    const html = render("needs-you", {
      jobs: data.jobs.filter((job) => job.status === "queued"),
      workers: [
        {
          worker_id: "unavailable-worker",
          available: signal !== "offline",
          busy: false,
          last_seen_at: new Date(
            now - (signal === "stale" ? 60_000 : 0),
          ).toISOString(),
        },
      ],
      details: {},
    });
    assert.match(html, /class="status-badge muted">Offline<\/span>/);
    assert.doesNotMatch(html, /status-blocked|>blocked<\/span>/i);
  });
}

test("progress is shown only for running jobs", () => {
  assert.match(
    render("board"),
    /<progress[^>]*value="42"[^>]*aria-label="Job progress"/,
  );
  assert.doesNotMatch(
    render("board", {
      jobs: data.jobs.filter((job) => job.status !== "running"),
    }),
    /<progress/,
  );
});
