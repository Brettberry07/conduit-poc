import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Checks,
  ChangedFiles,
  PublicationPanel,
  Timeline,
} from "../src/gui/client";
import { GET } from "../src/app/route";

test("verification distinguishes passed, failed, skipped, timeout and missing evidence", () => {
  const html = renderToStaticMarkup(
    createElement(Checks, {
      result: {
        verification: {
          checks: [
            { name: "Typecheck", exit_code: 0, timed_out: false },
            { name: "Tests", exit_code: 1 },
            { name: "Build", skipped: true },
            { name: "Lint", exit_code: 0, timed_out: true },
            { name: "Unknown", exit_code: null },
          ],
        },
      },
    }),
  );
  for (const label of [
    "passed",
    "failed",
    "skipped",
    "Timed out",
    "not reported",
  ])
    assert.ok(html.includes(label));
  assert.doesNotMatch(html, /exit_code|timed_out|<pre/);
});

test("publication uses recorded fields, a short SHA, and safe GitHub links", () => {
  const html = renderToStaticMarkup(
    createElement(PublicationPanel, {
      publication: {
        publication_state: "published",
        branch: "conduit/job-example",
        head_commit: "1234567890abcdef",
        pull_request_observed_at: "2026-11-07T18:00:00Z",
        pull_request: {
          number: 42,
          url: "https://github.com/example/repo/pull/42",
          state: "open",
          draft: true,
          merged: false,
        },
      },
    }),
  );
  assert.match(html, /Pull request #42/);
  assert.match(html, />12345678<\/code>/);
  assert.match(html, /conduit\/job-example/);
  assert.match(html, /<time[^>]*title=/);
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(PublicationPanel, {
        publication: {
          publication_state: "published",
          pull_request: {
            number: 1,
            url: "javascript:alert(1)",
            state: "open",
            draft: true,
            merged: false,
          },
        },
      }),
    ),
    /href=/,
  );
});

test("file summary includes counts and escapes file paths", () => {
  const html = renderToStaticMarkup(
    createElement(ChangedFiles, {
      files: [
        { path: "<script>.ts", status: "added" },
        { path: "app.ts", status: "modified" },
        { path: "old.ts", status: "deleted" },
        { path: "renamed.ts", status: "renamed" },
      ],
    }),
  );
  for (const label of ["added", "modified", "deleted", "renamed"])
    assert.match(html, new RegExp(`1 ${label}`));
  assert.doesNotMatch(html, /<script>|<pre/);
});

test("timeline presents executions and absolute hover times without JSON", () => {
  const html = renderToStaticMarkup(
    createElement(Timeline, {
      job: {
        id: "job",
        title: "Example",
        status: "completed",
        progress: 100,
        attempt_count: 1,
        created_at: "2026-11-07T17:00:00Z",
      },
      detail: {
        executions: [
          {
            attempt: 1,
            status: "completed",
            started_at: "2026-11-07T17:01:00Z",
            completed_at: "2026-11-07T17:02:00Z",
          },
        ],
      },
    }),
  );
  assert.match(html, /Attempt 1/);
  assert.match(html, /<svg/);
  assert.match(html, /<time[^>]*title=/);
  assert.doesNotMatch(html, /<pre/);
});

test("the public front door is static HTML with product destinations", async () => {
  const response = GET();
  assert.match(response.headers.get("content-type")!, /text\/html/);
  const html = await response.text();
  for (const path of [
    "/app",
    "/info",
    "https://github.com/Brettberry07/conduit-poc",
  ])
    assert.ok(html.includes(`href="${path}"`));
  assert.match(html, /color-scheme:light/);
  assert.doesNotMatch(html, /<script|<pre/);
});
