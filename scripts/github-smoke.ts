import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { apiOrigin } from "../worker/client";
import { registrationSchema } from "./project";
import { GitHub, type Project } from "../worker/development/github";
export function assertDisposableTarget(
  repository: string,
  metadata: { private?: boolean; topics?: string[] },
) {
  assert.notEqual(
    repository.toLowerCase(),
    "brettberry07/conduit-poc",
    "The smoke test must never target the main Conduit repository",
  );
  assert.ok(
    metadata.topics?.includes("conduit-disposable-test"),
    "Mark the dedicated repository with the conduit-disposable-test topic",
  );
}
export async function githubSmoke() {
  if (process.env.CONDUIT_RUN_GITHUB_INTEGRATION !== "1") {
    console.log(
      "SKIPPED: opt-in disposable GitHub integration is not configured",
    );
    return;
  }
  const file = process.env.CONDUIT_TEST_REGISTRATION_FILE,
    expected = process.env.CONDUIT_GITHUB_TEST_REPOSITORY;
  assert.ok(
    file && expected && process.env.SUBMITTER_KEY_FILE,
    "Set test registration, explicit disposable repository and submitter key files",
  );
  const registration = registrationSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  assert.ok(registration.id, "Use a fixed project UUID in test registration");
  assert.equal(
    `${registration.repository_owner}/${registration.repository_name}`,
    expected,
    "Disposable repository must match explicit allowlist",
  );
  const project: Project = {
    ...registration,
    id: registration.id,
    repository_url: `https://github.com/${expected}.git`,
    enabled: true,
  };
  assert.notEqual(
    expected.toLowerCase(),
    "brettberry07/conduit-poc",
    "The smoke test must never target the main Conduit repository",
  );
  const github = await GitHub.fromEnvironment(),
    repo = await github.request(project, "");
  assertDisposableTarget(expected, repo);
  await github.safety(project);
  const origin = apiOrigin(
    process.env.CONDUIT_API_URL ?? "http://127.0.0.1:3000",
  );
  const credential = JSON.parse(
    await readFile(process.env.SUBMITTER_KEY_FILE, "utf8"),
  );
  assert.equal(credential.role, "submitter");
  const defaultRef = `/git/ref/heads/${encodeURIComponent(project.default_branch)}`;
  const before = (await github.request(project, defaultRef)).object.sha;
  // Registration remains administrator-local; no registration capability is delegated to Instinct.
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/project.ts",
        "add",
        "--config",
        file,
      ],
      { stdio: ["ignore", "ignore", "ignore"], env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(
            Error(
              "Disposable project registration failed; run the project CLI for diagnostics",
            ),
          ),
    );
  });
  async function call(path: string, body?: unknown) {
    const requestId = randomUUID();
    const response = await fetch(new URL(path, origin), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + credential.token,
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw Error(`Conduit integration request failed (${response.status})`);
    return response.json();
  }
  async function wait(id: string) {
    let last = "";
    for (let i = 0; i < 450; i++) {
      const { job } = await call(`/api/jobs/${id}`);
      if (job.status !== last) {
        console.log(JSON.stringify({ job_id: id, status: job.status }));
        last = job.status;
      }
      if (["completed", "failed", "blocked"].includes(job.status)) {
        assert.equal(job.status, "completed", job.error ?? "Execution failed");
        return job;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw Error(
      "Timed out waiting for the Mac worker; retrieve the recorded job ID",
    );
  }
  const evidence: Record<string, unknown> = {
    repository: expected,
    default_head_before: before,
  };
  await mkdir("output", { recursive: true, mode: 0o700 });
  const evidencePath = resolve("output", `phase4-${randomUUID()}.json`);
  const save = () =>
    writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  try {
    const unique = randomUUID();
    const { job: created } = await call("/api/jobs", {
      task: "development",
      project_id: project.id,
      title: "Phase 4 disposable GitHub integration",
      instructions: `Create a source text file conduit-probe-${unique}.txt containing phase4-original on its own line. Do not modify other files.`,
      acceptance_criteria: "Configured verification passes; draft PR exists.",
    });
    evidence.job_id = created.id;
    await save();
    const first = await wait(created.id);
    evidence.first = first;
    await save();
    assert.equal(first.result.verification.status, "passed");
    assert.equal(first.result.pull_request.draft, true);
    const changes = await call(`/api/jobs/${created.id}/changes`),
      diff = await call(`/api/jobs/${created.id}/diff`);
    assert.ok(
      changes.files.some((v: any) => v.path === `conduit-probe-${unique}.txt`),
    );
    assert.match(diff.diff, /phase4-original/);
    evidence.changes = changes;
    evidence.diff = diff;
    await save();
    const { job: revision } = await call(`/api/jobs/${created.id}/revisions`, {
      instructions: `Change conduit-probe-${unique}.txt to contain phase4-revised on its own line. Preserve all other files.`,
      acceptance_criteria:
        "Configured verification passes; the original PR receives the revision.",
    });
    evidence.revision_id = revision.id;
    await save();
    const second = await wait(revision.id);
    evidence.revision = second;
    assert.equal(
      second.result.pull_request.number,
      first.result.pull_request.number,
    );
    assert.equal(second.result.branch, first.result.branch);
    assert.notEqual(second.result.head_commit, first.result.head_commit);
    const pr = await github.read(project, first.result.pull_request.number);
    assert.equal(pr.head, second.result.head_commit);
    assert.equal(pr.draft, true);
    assert.equal(pr.merged, false);
    const revised = await call(`/api/jobs/${revision.id}/diff`);
    assert.match(revised.diff, /phase4-revised/);
    evidence.revision_diff = revised;
    console.log(
      JSON.stringify({
        status: "passed",
        job_id: created.id,
        revision_id: revision.id,
        pull_request: pr.url,
        evidence: evidencePath,
      }),
    );
  } finally {
    const after = (await github.request(project, defaultRef)).object.sha;
    evidence.default_head_after = after;
    await save();
    assert.equal(after, before, "Default branch must remain unchanged");
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
)
  githubSmoke().catch(() => {
    console.error(
      "GitHub integration FAILED; inspect the private evidence file and worker. No integration success is claimed.",
    );
    process.exitCode = 1;
  });
