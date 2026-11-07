const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");

for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CONDUIT_GITHUB_TOKEN_FILE",
  "ADMIN_DATABASE_URL",
  "DATABASE_URL",
  "WORKER_KEY_FILE",
]) {
  assert.ok(
    process.env[name] === undefined,
    `Unexpected credential variable ${name}`,
  );
}

// The worker embeds this script in its private verification configuration so it
// can verify older worktrees and use the same discovery rules for every job.
const integrationSuites = new Set([
  "development-flow.test.ts",
  "development.test.ts",
  "events.test.ts",
  "github-auth.test.ts",
  "github-live.test.ts",
  "http.test.ts",
  "initiatives.test.ts",
  "queue.test.ts",
  "real-codex.test.ts",
]);
const files = readdirSync("tests", { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      /\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) &&
      !/\.integration\.test\./.test(entry.name) &&
      !integrationSuites.has(entry.name),
  )
  .map(({ name }) => "tests/" + name)
  .sort();
assert.ok(files.length, "No offline unit tests found");

// Inline the reporter so the private profile works without a worktree copy of
// this script or a temporary file readable by test code.
const reporter = `
import { relative, resolve } from "node:path";
import { inspect } from "node:util";
export default async function* report(source) {
  const stderr = new Map();
  for await (const { type, data } of source) {
    if (type === "test:stderr") {
      const file = data.entryFile ?? resolve(data.file);
      stderr.set(file, ((stderr.get(file) ?? "") + data.message).slice(0, 500));
    } else if (type === "test:fail") {
      const { name, file, line, details: { error } } = data;
      if (error.failureType === "subtestsFailed") continue;
      const location = file ? relative(process.cwd(), file) + ":" + (line ?? 1) : "";
      const signal = error.signal ? " (" + error.signal + ")" : "";
      const diagnostic = inspect(error.cause ?? error, { depth: 2, maxStringLength: 300 });
      yield "FAIL " + location + " " + name + signal + "\\n" + diagnostic.slice(0, 750) + "\\n";
      const entryFile = data.entryFile ?? file;
      if (stderr.has(entryFile)) {
        yield stderr.get(entryFile).trimEnd() + "\\n";
        stderr.delete(entryFile);
      }
    } else if (type === "test:summary" && !data.file) {
      yield "Offline tests: ${files.length} files, " + data.counts.passed + "/" + data.counts.tests + " passed\\n";
    }
  }
}
`;
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-reporter",
    "data:text/javascript," + encodeURIComponent(reporter),
    ...files,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
