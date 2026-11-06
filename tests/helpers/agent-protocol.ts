import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { protocol, policyVersion } from "../../src/lib/agent-protocol";
import { developmentInput } from "../../src/lib/development";
import { developmentContext } from "../../worker/development/context";

type Requester = (
  path: string,
  method?: string,
  body?: unknown,
  key?: "submitter" | "other" | "worker" | "reader",
  requestId?: ReturnType<typeof randomUUID>,
) => Promise<Response>;
export async function checkAgentProtocol(
  req: Requester,
  db: pg.Pool,
  project: string,
) {
  const previousEnforcement = process.env.CONDUIT_ENFORCE_POLICY_VERSION;
  const previousDescription = protocol.description;
  const research = {
    objective: "Improve status readability",
    summary: "Use redundant cues for status.",
    recommendations: ["Keep explicit text labels."],
    sources: [
      {
        title: "WCAG",
        url: "https://www.w3.org/TR/WCAG22/",
        accessed_at: "2026-11-06",
        relevance: "Accessible status",
        findings: "Do not rely only on color.",
      },
    ],
    uncertainties: ["Check existing component behavior"],
  };
  const input = {
    task: "development",
    project_id: project,
    title: "Research integration",
    original_request: "detailed: Improve status",
    instructions: "Preserve text cues",
    acceptance_criteria: "Status has a label",
    development_mode: "detailed",
    policy_version: policyVersion(),
    research,
  };
  const create = (body: unknown, id = randomUUID()) =>
    req("/api/jobs", "POST", body, "submitter", id);
  try {
    delete process.env.CONDUIT_ENFORCE_POLICY_VERSION;
    assert.equal(
      (await req("/api/agent/manifest", "GET", undefined, "reader")).status,
      200,
    );
    assert.equal(
      (await req("/api/agent/manifest", "GET", undefined, "worker")).status,
      403,
    );
    for (const extra of [
      { development_mode: "invalid" },
      { research: undefined },
      { research: { ...research, sources: [] } },
      { research: { ...research, summary: "x".repeat(6001) } },
      {
        research: {
          ...research,
          sources: [{ ...research.sources[0], url: "invalid" }],
        },
      },
      { research: { ...research, summary: "cnd_live_" + "x".repeat(43) } },
    ]) {
      assert.equal((await create({ ...input, ...extra })).status, 400);
    }
    assert.equal(
      (await create({ ...input, instructions: "x".repeat(100000) })).status,
      400,
    );
    const oversizedBody = {
      ...input,
      original_request: "界".repeat(12000),
      instructions: "界".repeat(12000),
      description: "界".repeat(4000),
      acceptance_criteria: "界".repeat(4000),
      research: { ...research, summary: "x".repeat(6000) },
    };
    assert.ok(developmentInput.safeParse(oversizedBody).success);
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedBody)) > 98304);
    assert.equal((await create(oversizedBody)).status, 400);
    const legacyId = randomUUID();
    const legacyBody = {
      task: "development",
      project_id: project,
      title: "Legacy",
      instructions: "Legacy instructions",
    };
    const legacy = (await (await create(legacyBody, legacyId)).json()).job;
    assert.equal(legacy.development_mode, "normal");
    assert.equal(legacy.research, null);
    assert.equal(legacy.policy_version, null);
    assert.equal(legacy.accepted_policy_version, policyVersion());
    const requestId = randomUUID();
    const response = await create(input, requestId);
    assert.equal(response.status, 201, await response.clone().text());
    const accepted = (await response.json()).job;
    assert.deepEqual(accepted.research, research);
    assert.equal(accepted.original_request, input.original_request);
    assert.equal(accepted.policy_version, input.policy_version);
    assert.equal(accepted.accepted_policy_version, input.policy_version);
    assert.deepEqual(
      (await (await req(`/api/jobs/${accepted.id}`)).json()).job.research,
      research,
    );
    assert.equal(
      (await req(`/api/jobs/${accepted.id}`, "GET", undefined, "other")).status,
      404,
    );
    const otherJobs = await (
      await req("/api/jobs", "GET", undefined, "other")
    ).json();
    assert.ok(!JSON.stringify(otherJobs).includes(research.objective));
    assert.equal(
      (
        await create(
          { ...input, research: { ...research, summary: "Changed" } },
          requestId,
        )
      ).status,
      409,
    );
    // Simulate a subsequent release changing policy after jobs were accepted.
    protocol.description += " Updated policy";
    process.env.CONDUIT_ENFORCE_POLICY_VERSION = "true";
    const stale = await create(input);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /GET \/api\/agent\/manifest/);
    const missing = await create(legacyBody);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /policy_version is required/);
    for (const [body, id, expected] of [
      [input, requestId, accepted.id],
      [legacyBody, legacyId, legacy.id],
    ] as const) {
      const retry = await create(body, id);
      assert.equal(retry.status, 201);
      assert.equal((await retry.json()).job.id, expected);
    }
    assert.equal(
      (await create({ ...input, policy_version: policyVersion() })).status,
      201,
    );
    // Queued jobs and accepted research are independent of current policy checks.
    const claim = async () =>
      (await (await req("/api/claim", "POST", {}, "worker")).json()).job;
    assert.equal((await claim()).id, legacy.id);
    const claimed = await claim();
    assert.equal(claimed.id, accepted.id);
    assert.deepEqual(claimed.research, research);
    assert.ok(
      developmentContext(claimed).includes(research.sources[0].findings),
    );
    await db.query(
      "UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [accepted.id],
    );
    const reclaimed = await claim();
    assert.equal(reclaimed.id, accepted.id);
    assert.equal(reclaimed.attempt_count, 2);
    assert.deepEqual(reclaimed.research, research);
    // Revision storage changes neither the root task nor its branch/PR.
    await db.query(
      "UPDATE orchestrator.jobs SET status='completed',completed_at=clock_timestamp(),lease_expires_at=NULL WHERE id=$1",
      [accepted.id],
    );
    const pr = {
      number: 42,
      url: "https://github.com/example/disposable/pull/42",
      state: "open",
      draft: true,
      merged: false,
    };
    await db.query(
      "UPDATE orchestrator.development_tasks SET publication_state='published',head_commit=$2,pull_request=$3 WHERE job_id=$1",
      [accepted.id, "a".repeat(40), pr],
    );
    const revisePath = `/api/jobs/${accepted.id}/revisions`;
    const revBody = { instructions: "Correct observed keyboard issue" };
    assert.equal((await req(revisePath, "POST", revBody)).status, 400);
    assert.equal(
      (
        await req(revisePath, "POST", {
          ...revBody,
          policy_version: input.policy_version,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(
          revisePath,
          "POST",
          { ...revBody, policy_version: policyVersion() },
          "reader",
        )
      ).status,
      403,
    );
    const revId = randomUUID();
    const currentRev = { ...revBody, policy_version: policyVersion() };
    const revisionResponse = await req(
      revisePath,
      "POST",
      currentRev,
      "submitter",
      revId,
    );
    assert.equal(
      revisionResponse.status,
      201,
      await revisionResponse.clone().text(),
    );
    const revision = (await revisionResponse.json()).job;
    assert.equal(revision.root_job_id, accepted.id);
    assert.equal(revision.development_mode, "detailed");
    assert.deepEqual(revision.research, research);
    assert.equal(revision.original_request, revBody.instructions);
    assert.equal(revision.policy_version, currentRev.policy_version);
    assert.equal(revision.accepted_policy_version, currentRev.policy_version);
    protocol.description += " Another update";
    assert.equal(
      (await req(revisePath, "POST", currentRev, "submitter", revId)).status,
      201,
    );
    const updatedResearch = { ...research, summary: "Revised findings" };
    const updated = await req(revisePath, "POST", {
      ...revBody,
      research: updatedResearch,
      policy_version: policyVersion(),
    });
    assert.equal(updated.status, 201);
    assert.deepEqual((await updated.json()).job.research, updatedResearch);
    assert.deepEqual(
      (await (await req(`/api/jobs/${accepted.id}/publication`)).json())
        .publication.pull_request,
      pr,
    );
    assert.equal(
      (await req(`/api/jobs/${revision.id}`, "GET", undefined, "other")).status,
      404,
    );
  } finally {
    protocol.description = previousDescription;
    if (previousEnforcement === undefined)
      delete process.env.CONDUIT_ENFORCE_POLICY_VERSION;
    else process.env.CONDUIT_ENFORCE_POLICY_VERSION = previousEnforcement;
    await db.query("TRUNCATE orchestrator.jobs,orchestrator.workers CASCADE");
  }
}
