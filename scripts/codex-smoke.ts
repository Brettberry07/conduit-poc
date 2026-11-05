import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { apiOrigin } from "../worker/client";
const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "average" },
    "job-id": { type: "string" },
  },
});
const scenario = values.scenario!;
assert.ok(
  ["average", "failure", "timeout"].includes(scenario),
  "Use average, failure or timeout",
);
const origin = apiOrigin(
  process.env.CONDUIT_API_URL ?? "http://127.0.0.1:3000",
);
if (!process.env.SUBMITTER_KEY_FILE) throw Error("Set SUBMITTER_KEY_FILE");
const key = JSON.parse(await readFile(process.env.SUBMITTER_KEY_FILE, "utf8"));
assert.equal(key.role, "submitter");
const requestId = randomUUID();
async function call(path: string, body?: unknown) {
  const r = await fetch(new URL(path, origin), {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${key.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw Error(`API HTTP ${r.status}`);
  return r.json();
}
const instructions =
  scenario === "average"
    ? "Create and export an average(numbers: number[]) function. Return 0 for an empty array. Add unit tests covering empty arrays, positive values, and negative values."
    : scenario === "failure"
      ? "Create test/intentional-failure.test.mjs using node:test and node:assert/strict. Add one test asserting assert.equal(1, 2). This is an intentional failure-handling experiment: leave that assertion failing. Do not change existing files to fix it."
      : "Implement a complete parser and evaluator for arithmetic expressions with nested parentheses, precedence, syntax errors, and extensive unit tests. Take the time to implement and verify all cases.";
const id =
  values["job-id"] ??
  (
    await call("/api/jobs", {
      title: `Phase 3 ${scenario} probe`,
      task: "codex_task",
      project: "typescript-sandbox",
      instructions,
      acceptance_criteria:
        scenario === "failure"
          ? "The worker must report failing verification."
          : "TypeScript and unit tests pass.",
    })
  ).job.id;
await mkdir("output", { recursive: true });
console.log(JSON.stringify({ job_id: id, request_id: requestId, scenario }));
await writeFile(
  `output/phase3-${id}.json`,
  JSON.stringify({ job_id: id, request_id: requestId, scenario }),
  { mode: 0o600 },
);
let final: any;
for (let i = 0; i < 360; i++) {
  const { job } = await call(`/api/jobs/${id}`);
  if (["completed", "failed"].includes(job.status)) {
    final = job;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
assert.ok(final, "Timed out polling; retrieve using the printed job ID");
await writeFile(`output/phase3-${id}.json`, JSON.stringify(final, null, 2), {
  mode: 0o600,
});
assert.equal(final.result.simulated, false);
assert.ok(
  final.worker_id &&
    final.attempt_count &&
    final.claimed_at &&
    final.completed_at,
);
assert.ok(final.result.attempt_id);
if (scenario === "average") {
  assert.equal(final.status, "completed");
  assert.equal(final.result.execution.status, "completed");
  assert.equal(final.result.verification.status, "passed");
  assert.ok(final.result.changed_files.includes("src/index.ts"));
  assert.ok(
    final.result.changed_files.some((p: string) => p.startsWith("test/")),
  );
  assert.ok(final.result.thread_id);
  assert.ok(final.result.events.some((e: any) => e.type === "turn.completed"));
  assert.deepEqual(
    final.result.verification.checks.map((c: any) => [c.name, c.exit_code]),
    [
      ["typescript", 0],
      ["unit_tests", 0],
    ],
  );
} else {
  assert.equal(final.status, "failed");
  assert.ok(final.error);
  if (scenario === "failure") {
    assert.equal(final.result.execution.status, "completed");
    assert.equal(final.result.verification.status, "failed");
    assert.notEqual(
      final.result.verification.checks.find((c: any) => c.name === "unit_tests")
        .exit_code,
      0,
    );
  } else assert.match(final.result.execution.error, /timed out|interrupted/);
}
console.log(
  JSON.stringify(
    {
      job_id: id,
      status: final.status,
      execution: final.result.execution,
      verification: final.result.verification,
      changed_files: final.result.changed_files,
      workspace: final.result.workspace,
      worker_id: final.worker_id,
      attempt_count: final.attempt_count,
    },
    null,
    2,
  ),
);
