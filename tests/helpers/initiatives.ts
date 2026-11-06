import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { policyVersion, protocol } from "../../src/lib/agent-protocol";

type Requester = (
  path: string,
  method?: string,
  body?: unknown,
  key?: "submitter" | "other" | "worker" | "reader",
  requestId?: ReturnType<typeof randomUUID>,
) => Promise<Response>;
export function examplePlan(project: string) {
  const task = (
    task_key: string,
    title: string,
    dependencies: string[] = [],
  ) => ({
    task_key,
    title,
    description: "Conduit coding-agent support",
    instructions: `Implement ${title} within the registered repository; preserve Codex.`,
    acceptance_criteria: "Existing Codex behavior and configured checks pass",
    development_mode: "normal",
    dependencies,
  });
  return {
    project_id: project,
    title: "Add Claude Code support to Conduit",
    description: "Persistent multi-task example",
    original_request:
      "Add Claude Code support to Conduit. Figure out what needs to change and handle the implementation.",
    goal: "Selectable coding agents",
    acceptance_criteria: "Both providers work with existing queue and recovery",
    development_mode: "normal",
    tasks: [
      task("agent-interface", "Shared coding-agent execution interface"),
      task(
        "claude-configuration",
        "Validate Claude installation and configuration",
      ),
      task("claude-provider", "Implement provider using shared interface", [
        "agent-interface",
        "claude-configuration",
      ]),
      task("integration-tests", "Verify providers and failure handling", [
        "claude-provider",
      ]),
    ],
  };
}
export async function checkInitiatives(
  req: Requester,
  db: pg.Pool,
  project: string,
) {
  const plan = examplePlan(project),
    creationId = randomUUID();
  const create = (
    plan: unknown,
    id = randomUUID(),
    who: "submitter" | "other" | "worker" | "reader" = "submitter",
  ) =>
    req(
      "/api/initiatives",
      "POST",
      { plan, policy_version: policyVersion() },
      who,
      id,
    );
  const ok = async (r: Response, status = 200) => {
    assert.equal(r.status, status, await r.clone().text());
    return r.json();
  };
  const count = async () =>
    Number(
      (await db.query("SELECT count(*) FROM orchestrator.jobs")).rows[0].count,
    );
  const before = await count();
  for (const who of ["reader", "worker"] as const)
    assert.equal((await create(plan, randomUUID(), who)).status, 403);
  assert.equal(
    (await req("/api/initiatives", "GET", undefined, "worker")).status,
    403,
  );
  assert.equal(
    (await create({ ...plan, project_id: randomUUID() })).status,
    400,
  );
  const invalids = [
    { ...plan, tasks: [] },
    { ...plan, tasks: Array(21).fill(plan.tasks[0]) },
    { ...plan, tasks: [plan.tasks[0], plan.tasks[0]] },
    { ...plan, tasks: [{ ...plan.tasks[0], dependencies: ["missing"] }] },
    {
      ...plan,
      tasks: [{ ...plan.tasks[0], dependencies: ["agent-interface"] }],
    },
    {
      ...plan,
      tasks: [
        plan.tasks[0],
        {
          ...plan.tasks[1],
          dependencies: ["agent-interface", "agent-interface"],
        },
      ],
    },
    {
      ...plan,
      tasks: [
        { ...plan.tasks[0], dependencies: ["claude-configuration"] },
        { ...plan.tasks[1], dependencies: ["agent-interface"] },
      ],
    },
    { ...plan, tasks: [{ ...plan.tasks[0], development_mode: "detailed" }] },
    { ...plan, tasks: [{ ...plan.tasks[0], arbitrary_shell: "no" }] },
    {
      ...plan,
      tasks: Array.from({ length: 11 }, (_, n) => ({
        ...plan.tasks[0],
        task_key: `t-${n}`,
        dependencies: n ? [`t-${n - 1}`] : [],
      })),
    },
  ];
  for (const p of invalids) assert.equal((await create(p)).status, 400);
  const first = await ok(await create(plan, creationId), 201),
    id = first.initiative.id,
    base = `/api/initiatives/${id}`;
  assert.equal(await count(), before, "saving a draft must never create jobs");
  const duplicate = await Promise.all([
    create(plan, creationId),
    create(plan, creationId),
  ]);
  for (const r of duplicate) assert.equal((await ok(r, 201)).initiative.id, id);
  assert.equal(
    (await create({ ...plan, title: "Different" }, creationId)).status,
    409,
  );
  for (const suffix of ["", "/plan", "/resume", "/reviews"])
    assert.equal(
      (await req(base + suffix, "GET", undefined, "other")).status,
      404,
    );
  assert.equal(
    (await ok(await req("/api/initiatives", "GET", undefined, "other")))
      .initiatives.length,
    0,
  );
  assert.equal((await ok(await req(base + "/resume"))).progress.not_started, 4);
  const changed = { ...plan, description: "Refined plan" };
  const patch = {
    expected_plan_version: 1,
    plan: changed,
    explanation: "Clarify project context",
  };
  const updates = await Promise.all([
    req(base + "/plan", "PATCH", patch),
    req(base + "/plan", "PATCH", patch),
  ]);
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await ok(await req(base + "/plan"))).plan_version, 2);
  assert.equal(
    (await ok(await req(base + "/plan?version=1"))).plan.description,
    plan.description,
  );
  assert.equal(
    (
      await req(
        base + "/plan",
        "PATCH",
        { ...patch, expected_plan_version: 2 },
        "reader",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(
        base + "/plan",
        "PATCH",
        { ...patch, expected_plan_version: 2 },
        "other",
      )
    ).status,
    404,
  );
  assert.equal(
    (await req(base + "/activate", "POST", { expected_plan_version: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await req(base + "/activate", "POST", {
        expected_plan_version: 2,
        policy_version: "old",
      })
    ).status,
    409,
  );
  await db.query("UPDATE orchestrator.projects SET enabled=false WHERE id=$1", [
    project,
  ]);
  assert.equal(
    (
      await req(base + "/activate", "POST", {
        expected_plan_version: 2,
        policy_version: policyVersion(),
      })
    ).status,
    400,
  );
  await db.query("UPDATE orchestrator.projects SET enabled=true WHERE id=$1", [
    project,
  ]);
  // Fail on the second real root INSERT, after the first root/task has been linked.
  await db.query(`CREATE FUNCTION orchestrator.test_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.title='Validate Claude installation and configuration' THEN RAISE EXCEPTION 'simulated transaction failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_activation_failure BEFORE INSERT ON orchestrator.jobs FOR EACH ROW EXECUTE FUNCTION orchestrator.test_activation_failure()`);
  try {
    assert.equal(
      (
        await req(base + "/activate", "POST", {
          expected_plan_version: 2,
          policy_version: policyVersion(),
        })
      ).status,
      500,
    );
    assert.equal(
      await count(),
      before,
      "the first INSERT must roll back after second-job failure",
    );
    const unchanged = await ok(await req(base + "/plan"));
    assert.ok(unchanged.tasks.every((t: any) => t.root_job_id === null));
  } finally {
    await db.query(
      "DROP TRIGGER test_activation_failure ON orchestrator.jobs; DROP FUNCTION orchestrator.test_activation_failure()",
    );
  }
  const activationId = randomUUID(),
    activation = { expected_plan_version: 2, policy_version: policyVersion() };
  const activated = await Promise.all([
    req(base + "/activate", "POST", activation, "submitter", activationId),
    req(base + "/activate", "POST", activation, "submitter", activationId),
  ]);
  const jobs = (await ok(activated[0], 201)).jobs;
  assert.deepEqual((await ok(activated[1], 201)).jobs, jobs);
  assert.equal(await count(), before + 4);
  assert.equal((await req(base + "/activate", "POST", activation)).status, 409);
  assert.equal(
    (
      await req(
        base + "/activate",
        "POST",
        { ...activation, expected_plan_version: 1 },
        "submitter",
        activationId,
      )
    ).status,
    409,
  );
  assert.equal(
    (await req(base + "/plan", "PATCH", { ...patch, expected_plan_version: 2 }))
      .status,
    409,
  );
  const roots = Object.fromEntries(
    jobs.map((t: any) => [t.task_key, t.root_job_id]),
  );
  const stored = (
    await db.query(
      "SELECT * FROM orchestrator.jobs WHERE id=ANY($1::uuid[]) ORDER BY created_at",
      [Object.values(roots)],
    )
  ).rows;
  assert.equal(stored.filter((j) => j.status === "queued").length, 2);
  assert.equal(
    stored.filter((j) => j.status === "waiting_dependencies").length,
    2,
  );
  assert.deepEqual(
    stored.find((j) => j.id === roots["claude-provider"]).dependency_job_ids,
    [roots["agent-interface"], roots["claude-configuration"]],
  );
  for (const j of stored) {
    assert.equal(j.accepted_policy_version, activation.policy_version);
    assert.equal(j.original_request, plan.original_request);
  }
  // Accepted retries remain valid across changed policy and project availability.
  const oldDescription = protocol.description;
  try {
    protocol.description += " simulated new policy";
    await db.query(
      "UPDATE orchestrator.projects SET enabled=false WHERE id=$1",
      [project],
    );
    assert.equal((await create(plan, creationId)).status, 201);
    assert.equal(
      (
        await req(
          base + "/activate",
          "POST",
          activation,
          "submitter",
          activationId,
        )
      ).status,
      201,
    );
  } finally {
    protocol.description = oldDescription;
    await db.query(
      "UPDATE orchestrator.projects SET enabled=true WHERE id=$1",
      [project],
    );
  }
  const lifecycle = (expected_status: string, status: string, extra = {}) =>
    req(base, "PATCH", { expected_status, status, ...extra });
  assert.equal(
    (
      await lifecycle("active", "completed", {
        completion_summary: "Premature",
      })
    ).status,
    409,
  );
  await ok(await lifecycle("active", "paused"));
  const claim = async () =>
    (await ok(await req("/api/claim", "POST", {}, "worker"))).job;
  assert.equal(await claim(), null);
  await ok(await lifecycle("paused", "active"));
  const a = await claim(),
    b = await claim();
  assert.deepEqual(
    new Set([a.id, b.id]),
    new Set([roots["agent-interface"], roots["claude-configuration"]]),
  );
  await ok(await lifecycle("active", "paused"));
  // Existing live claims keep running and can publish/report while paused.
  const publish = async (job: any, n: number) => {
    await ok(
      await req(
        `/api/jobs/${job.id}/publication`,
        "POST",
        {
          claim_token: job.claim_token,
          head_commit: "a".repeat(40),
          publication_state: "published",
          phase: "publishing",
          pull_request: {
            number: n,
            url: `https://github.com/example/disposable/pull/${n}`,
            draft: true,
            state: "open",
            merged: false,
            head: "a".repeat(40),
          },
        },
        "worker",
      ),
    );
    await ok(
      await req(
        `/api/jobs/${job.id}/report`,
        "POST",
        {
          claim_token: job.claim_token,
          action: "completed",
          progress: 100,
          result: { verification: { status: "passed" } },
        },
        "worker",
      ),
    );
  };
  await publish(a, 101);
  await publish(b, 102);
  let resume = await ok(await req(base + "/resume"));
  assert.equal(resume.progress.awaiting_review, 2);
  assert.equal(resume.progress.merged, 0);
  assert.equal(resume.progress.waiting_dependencies, 2);
  assert.match(
    resume.tasks.find((t: any) => t.task_key === "claude-provider")
      .waiting_on[0].reason,
    /merge/,
  );
  assert.ok(
    resume.tasks.find((t: any) => t.root_job_id === a.id).pr_observation
      .observed_at,
  );
  assert.equal(resume.tasks[0].pr_observation.live, false);
  await ok(await lifecycle("paused", "active"));
  assert.equal(
    await claim(),
    null,
    "published draft PRs must not release dependent jobs",
  );
  const reviewId = randomUUID(),
    review = {
      task_key: jobs.find((t: any) => t.root_job_id === a.id).task_key,
      job_id: a.id,
      observed_head_sha: "a".repeat(40),
      outcome: "needs_decision",
      summary: "Choose compatibility behavior",
      criteria_evaluated: ["Configured checks"],
      evidence_references: [`/api/jobs/${a.id}/diff`],
      outstanding_concerns: ["User choice required"],
    };
  const reviewPath = base + "/reviews";
  const assessment = await ok(
    await req(reviewPath, "POST", review, "submitter", reviewId),
    201,
  );
  assert.equal(
    (
      await ok(
        await req(reviewPath, "POST", review, "submitter", reviewId),
        201,
      )
    ).review.id,
    assessment.review.id,
  );
  assert.equal(
    (
      await req(
        reviewPath,
        "POST",
        { ...review, summary: "Different" },
        "submitter",
        reviewId,
      )
    ).status,
    409,
  );
  assert.equal((await req(reviewPath, "POST", review, "reader")).status, 403);
  assert.equal((await req(reviewPath, "POST", review, "other")).status, 404);
  assert.equal(
    (
      await req(reviewPath, "POST", {
        ...review,
        job_id: roots["integration-tests"],
      })
    ).status,
    400,
  );
  resume = await ok(await req(base + "/resume"));
  assert.equal(resume.unresolved_decisions.length, 1);
  assert.equal(
    resume.tasks.find((t: any) => t.root_job_id === a.id).reviews[0].stale,
    false,
  );
  // Use existing same-PR revision API, preserving the root mapping and branch.
  const revision = (
    await ok(
      await req(`/api/jobs/${a.id}/revisions`, "POST", {
        instructions: "Address observed issue",
        policy_version: policyVersion(),
      }),
      201,
    )
  ).job;
  resume = await ok(await req(base + "/resume"));
  const revisedTask = resume.tasks.find((t: any) => t.root_job_id === a.id);
  assert.equal(revisedTask.revision_count, 1);
  assert.equal(revisedTask.latest_job_id, revision.id);
  assert.equal(revisedTask.reviews[0].stale, true);
  assert.equal(revisedTask.state, "queued");
  assert.equal((await claim()).id, revision.id);
  await db.query(
    "UPDATE orchestrator.jobs SET status='completed',completed_at=clock_timestamp(),lease_expires_at=NULL,result=$2 WHERE id=$1",
    [revision.id, { verification: { status: "passed" } }],
  );
  await db.query(
    "UPDATE orchestrator.development_tasks SET head_commit=$2 WHERE job_id=$1",
    [a.id, "b".repeat(40)],
  );
  const resolved = {
    ...review,
    job_id: revision.id,
    observed_head_sha: "b".repeat(40),
    outcome: "ready_for_human_review",
    summary: "User decision applied",
    outstanding_concerns: [],
  };
  await ok(await req(reviewPath, "POST", resolved), 201);
  assert.equal(
    (await ok(await req(base + "/resume"))).unresolved_decisions.length,
    0,
  );
  const page = await ok(await req(reviewPath + "?limit=1"));
  assert.ok(page.next_before);
  assert.equal(
    (await ok(await req(reviewPath + `?before=${page.next_before}`))).reviews
      .length,
    1,
  );
  const reconcile = async (job: any, n: number) =>
    ok(
      await req(
        "/api/development/reconcile",
        "POST",
        {
          root_job_id: job.id,
          pull_request: {
            number: n,
            url: `https://github.com/example/disposable/pull/${n}`,
            draft: false,
            state: "closed",
            merged: true,
          },
        },
        "worker",
      ),
    );
  await reconcile(a, 101);
  assert.equal(
    await claim(),
    null,
    "both prerequisites must be observed merged",
  );
  await reconcile(b, 102);
  const provider = await claim();
  assert.equal(provider.id, roots["claude-provider"]);
  await ok(
    await req(
      `/api/jobs/${provider.id}/report`,
      "POST",
      {
        claim_token: provider.claim_token,
        action: "failed",
        error: "Mock provider failure",
        result: { verification: { status: "failed" } },
      },
      "worker",
    ),
  );
  assert.equal(await claim(), null);
  resume = await ok(await req(base + "/resume"));
  assert.equal(resume.progress.merged, 2);
  assert.equal(resume.progress.failed, 2);
  assert.equal(resume.initiative.status, "active");
  assert.equal(resume.initiative.plan_version, 2);
  assert.equal(resume.initiative.original_request, plan.original_request);
  assert.equal(resume.outstanding_failures.length, 2);
  assert.ok(resume.next_actions.some((a: any) => a.type === "inspect_failure"));
  assert.ok(
    !JSON.stringify(resume).includes(plan.tasks[0].instructions),
    "resume must not dump instructions/logs/research",
  );
  assert.equal(
    await count(),
    before + 5,
    "only explicit same-PR revision adds another job",
  );
  await ok(await lifecycle("active", "cancelled"));
  assert.equal((await lifecycle("active", "paused")).status, 409);
  // Separate deliberate task modes: initiative-wide research is not copied/inherited.
  const research = {
    objective: "Provider contracts",
    summary: "Read provider CLI documentation",
    recommendations: ["Keep explicit failure handling"],
    sources: [
      {
        title: "CLI reference",
        url: "https://example.com/cli",
        accessed_at: "2026-11-06",
        relevance: "Invocation contract",
        findings: "Mocked primary-source fixture",
      },
    ],
  };
  const detailed = {
    ...plan,
    development_mode: "detailed",
    research,
    tasks: [
      { ...plan.tasks[0], development_mode: "detailed", research },
      plan.tasks[1],
    ],
  };
  const di = (await ok(await create(detailed), 201)).initiative;
  const dj = (
    await ok(
      await req(`/api/initiatives/${di.id}/activate`, "POST", {
        expected_plan_version: 1,
        policy_version: policyVersion(),
      }),
      201,
    )
  ).jobs;
  const delivered = (
    await db.query("SELECT * FROM orchestrator.jobs WHERE id=ANY($1::uuid[])", [
      dj.map((j: any) => j.root_job_id),
    ])
  ).rows;
  assert.equal(
    delivered.find((j) => j.development_mode === "normal").research,
    null,
  );
  assert.equal(
    delivered.find((j) => j.development_mode === "detailed").research.sources[0]
      .url,
    research.sources[0].url,
  );
  // Cancellation preserves history, prevents dispatch and cannot be reversed accidentally.
  await ok(
    await req(`/api/initiatives/${di.id}`, "PATCH", {
      expected_status: "active",
      status: "cancelled",
    }),
  );
  assert.equal(await claim(), null);
  assert.equal(
    (
      await req(`/api/jobs/${a.id}/revisions`, "POST", {
        instructions: "Cannot reopen cancelled work",
        policy_version: policyVersion(),
      })
    ).status,
    409,
  );
  // Valid maximum plan, missing UUID, streamed body bounds and fixed project identity.
  const maximum = {
    ...plan,
    tasks: Array.from({ length: 20 }, (_, n) => ({
      ...plan.tasks[0],
      task_key: `task-${n}`,
    })),
  };
  const maximumDraft = (await ok(await create(maximum), 201)).initiative;
  assert.equal(
    (await ok(await req(`/api/initiatives/${maximumDraft.id}/plan`))).plan.tasks
      .length,
    20,
  );
  const invalidProjectEdit = {
    expected_plan_version: 1,
    plan: { ...maximum, project_id: randomUUID() },
  };
  assert.equal(
    (
      await req(
        `/api/initiatives/${maximumDraft.id}/plan`,
        "PATCH",
        invalidProjectEdit,
      )
    ).status,
    409,
  );
  const bodyLimit = {
    ...maximum,
    tasks: maximum.tasks.map((t) => ({
      ...t,
      instructions: "界".repeat(12000),
    })),
  };
  assert.equal((await create(bodyLimit)).status, 400);
  // Current enforcement applies to unaccepted activation; accepted retries bypass it.
  const oneTask = { ...plan, tasks: [plan.tasks[0]] };
  const completeDraft = (await ok(await create(oneTask), 201)).initiative,
    completeBase = `/api/initiatives/${completeDraft.id}`;
  const enforcement = process.env.CONDUIT_ENFORCE_POLICY_VERSION;
  process.env.CONDUIT_ENFORCE_POLICY_VERSION = "true";
  try {
    assert.equal(
      (await req("/api/initiatives", "POST", { plan: oneTask })).status,
      400,
    );
    assert.equal(
      (
        await req(completeBase + "/activate", "POST", {
          expected_plan_version: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          base + "/activate",
          "POST",
          { expected_plan_version: 2 },
          "submitter",
          activationId,
        )
      ).status,
      201,
    );
  } finally {
    if (enforcement === undefined)
      delete process.env.CONDUIT_ENFORCE_POLICY_VERSION;
    else process.env.CONDUIT_ENFORCE_POLICY_VERSION = enforcement;
  }
  const competing = await Promise.all([
    req(completeBase + "/activate", "POST", {
      expected_plan_version: 1,
      policy_version: policyVersion(),
    }),
    req(completeBase + "/activate", "POST", {
      expected_plan_version: 1,
      policy_version: policyVersion(),
    }),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  const completeJobs = (await competing.find((r) => r.status === 201)!.json())
    .jobs;
  assert.equal(completeJobs.length, 1);
  const queuedComplete = (await ok(await req(completeBase + "/resume")))
    .tasks[0];
  assert.equal(queuedComplete.pr_observation.source, "unavailable");
  assert.equal(queuedComplete.pr_observation.observed_at, null);
  const live = await claim();
  assert.equal(live.id, completeJobs[0].root_job_id);
  await ok(
    await req(completeBase, "PATCH", {
      expected_status: "active",
      status: "paused",
    }),
  );
  await db.query(
    "UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [live.id],
  );
  assert.equal(
    await claim(),
    null,
    "paused initiatives also fence lease recovery",
  );
  await ok(
    await req(completeBase, "PATCH", {
      expected_status: "paused",
      status: "active",
    }),
  );
  const recovered = await claim();
  assert.equal(recovered.id, live.id);
  assert.equal(recovered.attempt_count, 2);
  await publish(recovered, 103);
  const completeReview = {
    ...review,
    task_key: "agent-interface",
    job_id: live.id,
    outcome: "ready_for_human_review",
    summary: "Inspected implementation",
    outstanding_concerns: [],
  };
  const concurrentReviewId = randomUUID();
  const concurrentReviews = await Promise.all([
    req(
      completeBase + "/reviews",
      "POST",
      completeReview,
      "submitter",
      concurrentReviewId,
    ),
    req(
      completeBase + "/reviews",
      "POST",
      completeReview,
      "submitter",
      concurrentReviewId,
    ),
  ]);
  assert.equal(
    (await ok(concurrentReviews[0], 201)).review.id,
    (await ok(concurrentReviews[1], 201)).review.id,
  );
  // A reconciled external head change must stale an assessment even when local head is unchanged.
  await ok(
    await req(
      "/api/development/reconcile",
      "POST",
      {
        root_job_id: live.id,
        pull_request: {
          number: 103,
          url: "https://github.com/example/disposable/pull/103",
          draft: true,
          state: "open",
          merged: false,
          head: "c".repeat(40),
        },
      },
      "worker",
    ),
  );
  assert.equal(
    (await ok(await req(completeBase + "/resume"))).tasks[0].reviews[0].stale,
    true,
  );
  assert.equal(
    (await ok(await req(completeBase + "/reviews"))).reviews[0].stale,
    true,
  );
  // Legacy observations explicitly keep unknown freshness, rather than using updated_at.
  await db.query(
    "UPDATE orchestrator.development_tasks SET pull_request_observed_at=NULL WHERE job_id=$1",
    [live.id],
  );
  assert.equal(
    (await ok(await req(completeBase + "/resume"))).tasks[0].pr_observation
      .observed_at,
    null,
  );
  await reconcile(live, 103);
  assert.equal(
    (await ok(await req(completeBase + "/resume"))).initiative.status,
    "active",
    "merge never auto-completes the objective",
  );
  await ok(
    await req(completeBase + "/reviews", "POST", {
      ...completeReview,
      outcome: "needs_decision",
      summary: "Confirm release acceptance",
    }),
    201,
  );
  assert.equal(
    (
      await req(completeBase, "PATCH", {
        expected_status: "active",
        status: "completed",
        completion_summary: "Too early",
      })
    ).status,
    409,
  );
  await ok(
    await req(completeBase + "/reviews", "POST", {
      ...completeReview,
      summary: "User acceptance decision recorded",
    }),
    201,
  );
  const completion = await ok(
    await req(completeBase, "PATCH", {
      expected_status: "active",
      status: "completed",
      completion_summary:
        "Overall acceptance reviewed against the requested behavior",
    }),
  );
  assert.ok(completion.initiative.completed_at);
  assert.equal(
    (await ok(await req(completeBase + "/resume"))).tasks[0].integration_state,
    "integrated_pm_confirmed",
  );
  assert.equal(
    (
      await req(`/api/jobs/${live.id}/revisions`, "POST", {
        instructions: "Cannot reopen completed work",
        policy_version: policyVersion(),
      })
    ).status,
    409,
  );
  const oversizedJobPlan = {
    ...plan,
    original_request: "界".repeat(12000),
    tasks: [
      {
        ...plan.tasks[0],
        instructions: "界".repeat(12000),
        description: "界".repeat(4000),
        acceptance_criteria: "界".repeat(4000),
        research: { ...research, summary: "x".repeat(6000) },
      },
    ],
  };
  const oversizedDraft = (await ok(await create(oversizedJobPlan), 201))
    .initiative;
  const jobCount = await count();
  const oversizedActivation = await req(
    `/api/initiatives/${oversizedDraft.id}/activate`,
    "POST",
    { expected_plan_version: 1, policy_version: policyVersion() },
  );
  assert.equal(oversizedActivation.status, 400);
  assert.match((await oversizedActivation.json()).error, /byte limit/);
  assert.equal(await count(), jobCount);
  // Composite owner/family foreign keys reject indirect cross-principal links even below HTTP.
  await assert.rejects(
    db.query(
      `INSERT INTO orchestrator.initiative_reviews(initiative_id,task_key,owner,root_job_id,job_id,request_id,content) VALUES($1,'agent-interface','other',$2,$2,$3,'{}')`,
      [completeDraft.id, live.id, randomUUID()],
    ),
    /foreign key/,
  );
  return { initiative_id: id, task_job_ids: roots, resume };
}
