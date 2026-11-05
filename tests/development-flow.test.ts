import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { fixture, fakeGitHub } from "./helpers/development";
import {
  git,
  fetchBranch,
  remoteHead,
  safePush,
  validateRepository,
} from "../worker/development/git";
import {
  executeDevelopment,
  type DevelopmentJob,
  type DevelopmentDependencies,
} from "../worker/development/run";
import { handle } from "../src/lib/api";
import { generateKey, hashKey } from "../src/lib/keys";
import { ApiError, type Call } from "../worker/runner";
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
function policyTest(
  name: string,
  options: { timeout: number },
  run: (t: TestContext, policy: "strict_bot" | "prototype") => Promise<void>,
) {
  for (const policy of ["strict_bot", "prototype"] as const)
    test(`${name} (${policy})`, options, (t) => run(t, policy));
}
policyTest(
  "Phase 4 API, fenced queue, actual Git, publication recovery, revisions and dependencies",
  { timeout: 120000 },
  async (t, policy) => {
    const security =
      policy === "strict_bot"
        ? { policy }
        : {
            policy,
            acknowledge_prototype_risk: true as const,
            approved_repositories: ["example/disposable"],
          };
    const f = await fixture(),
      fake = fakeGitHub(f, security),
      port = await freePort();
    const postgres = new EmbeddedPostgres({
      databaseDir: join(f.dir, "db"),
      port,
      user: "postgres",
      password: "test-only",
      persistent: false,
      autoRehydrateSymlinks: true,
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {},
      onError: () => {},
    });
    let db: pg.Pool | undefined, runtime: pg.Pool | undefined;
    try {
      await postgres.initialise();
      await postgres.start();
      db = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: "test-only",
        database: "postgres",
        max: 12,
      });
      for (const file of (await readdir("supabase/migrations")).sort())
        await db.query(
          await readFile(join("supabase/migrations", file), "utf8"),
        );
      await db.query(
        "CREATE ROLE phase4_runtime LOGIN PASSWORD 'runtime-only' INHERIT;GRANT conduit_api TO phase4_runtime",
      );
      runtime = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "phase4_runtime",
        password: "runtime-only",
        database: "postgres",
        max: 12,
      });
      const keys = {
        submitter: generateKey().token,
        other: generateKey().token,
        worker: generateKey().token,
        reader: generateKey().token,
      };
      for (const [name, token] of Object.entries(keys))
        await db.query(
          `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at) VALUES($1,$2,$3,$2,$4,$5,clock_timestamp()+interval '1 hour')`,
          [
            hashKey(token),
            name,
            name === "worker" ? "worker" : "submitter",
            token.slice(0, 17),
            name === "worker"
              ? ["jobs:claim", "jobs:update"]
              : name === "reader"
                ? ["jobs:read"]
                : ["jobs:create", "jobs:read", "jobs:revise"],
          ],
        );
      await db.query(
        `INSERT INTO orchestrator.projects(id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches) VALUES($1,'Disposable','example','disposable',$2,'main',ARRAY['main'])`,
        [f.project.id, f.project.repository_url],
      );
      const req = async (
        path: string,
        method = "GET",
        body?: unknown,
        key: keyof typeof keys = "submitter",
        requestId = randomUUID(),
      ) =>
        handle(
          new Request("http://localhost" + path, {
            method,
            headers: {
              Authorization: "Bearer " + keys[key],
              "Content-Type": "application/json",
              "Idempotency-Key": requestId,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          runtime!,
        );
      const call: Call = async (path, body) => {
        const r = await req(path, "POST", body, "worker");
        if (!r.ok) throw new ApiError(r.status);
        return r.json();
      };
      const input = {
        title: "Update disposable fixture",
        task: "development",
        project_id: f.project.id,
        instructions: "Update modified.txt and add new.txt",
        acceptance_criteria: "Configured checks pass",
      };
      const submit = async (extra = {}) => {
        const response = await req("/api/jobs", "POST", {
          ...input,
          ...extra,
        });
        assert.equal(response.status, 201, await response.clone().text());
        return (await response.json()).job;
      };
      let executions = 0,
        failVerification = false;
      const deps: DevelopmentDependencies = {
        github: fake.github,
        configs: [f.config],
        execute: async (workspace) => {
          executions++;
          await writeFile(
            join(workspace, "modified.txt"),
            `execution ${executions}\n`,
          );
          await writeFile(join(workspace, "new.txt"), `new ${executions}\n`);
          return {
            thread_id: "test-thread",
            checks: [
              {
                name: "unit_tests",
                exit_code: failVerification ? 1 : 0,
                timed_out: false,
              },
            ],
          };
        },
        network: {
          initialize: async () => {
            await validateRepository(f.repo, f.project);
            return f.repo;
          },
          validate: validateRepository,
          fetch: (repo, _url, branch) =>
            fetchBranch(repo, f.remote, branch, undefined, true),
          head: (repo, _url, branch) =>
            remoteHead(repo, f.remote, branch, undefined, true),
          push: (repo, _url, branch, head, expected) =>
            safePush(repo, f.remote, branch, head, expected, undefined, true),
        },
      };
      const run = async (job: DevelopmentJob, customCall = call) => {
        const outcome = await executeDevelopment(
          job,
          customCall,
          join(f.dir, "worker"),
          () => false,
          async () => {},
          deps,
        );
        await call(`/api/jobs/${job.id}/report`, {
          claim_token: job.claim_token,
          ...outcome,
        });
        return outcome;
      };
      await t.test(
        "invalid project, base, dependency, extra execution fields and scope boundaries",
        async () => {
          assert.equal((await req("/api/projects")).status, 200);
          for (const extra of [
            { project_id: randomUUID() },
            { base_branch: "evil" },
            { base_branch: "../main" },
            { repository_url: "https://evil.invalid" },
            { command: "touch /tmp/evil" },
            { github_security: { policy: "prototype" } },
            { github_token: "ghp_REMOTE_TEST_ONLY" },
            { dependency_job_ids: [randomUUID()] },
          ])
            assert.equal(
              (await req("/api/jobs", "POST", { ...input, ...extra })).status,
              400,
            );
          assert.equal(
            (await req("/api/projects", "POST", {}, "submitter")).status,
            404,
          );
          assert.equal(
            (await req("/api/projects", "GET", undefined, "worker")).status,
            403,
          );
          assert.equal(
            (await req("/api/jobs", "POST", input, "reader")).status,
            403,
          );
          await assert.rejects(
            runtime!.query("INSERT INTO orchestrator.projects(id) VALUES($1)", [
              randomUUID(),
            ]),
            /permission denied/,
          );
          await assert.rejects(
            runtime!.query("UPDATE orchestrator.projects SET enabled=false"),
            /permission denied/,
          );
        },
      );
      let root: any, firstHead: string;
      await t.test(
        "idempotent creation, lost PR creation response and review package",
        async () => {
          const request = randomUUID(),
            a = await req("/api/jobs", "POST", input, "submitter", request),
            b = await req("/api/jobs", "POST", input, "submitter", request);
          root = (await a.json()).job;
          assert.equal((await b.json()).job.id, root.id);
          assert.equal(
            (
              await req(
                "/api/jobs",
                "POST",
                { ...input, instructions: "different" },
                "submitter",
                request,
              )
            ).status,
            409,
          );
          fake.loseCreate();
          const { job } = await call("/api/claim", {});
          assert.equal(job.id, root.id);
          assert.ok(job.publication.branch.startsWith("conduit/job-"));
          const outcome = await run(job);
          assert.equal(outcome.action, "completed", JSON.stringify(outcome));
          assert.equal(fake.creates, 1);
          firstHead = String(outcome.result.head_commit);
          const { job: final } = await (
            await req(`/api/jobs/${root.id}`)
          ).json();
          assert.equal(final.status, "completed");
          assert.ok(
            fake.calls.every(
              (c) =>
                !c.path.includes("/merge") &&
                !["PUT", "DELETE"].includes(c.method),
            ),
          );
          assert.equal(final.result.github_security.policy, policy);
          if (policy === "prototype") {
            assert.match(
              final.result.warnings.join(" "),
              /credential may retain merge/,
            );
            assert.match(fake.pr.body, /credential may retain merge/);
          }
          assert.equal(final.claim_token, undefined);
          assert.equal(JSON.stringify(final).includes(f.dir), false);
          assert.equal(final.result.verification.status, "passed");
          assert.equal(final.result.pull_request.number, 42);
          const changes = await (
            await req(`/api/jobs/${root.id}/changes`)
          ).json();
          assert.equal(changes.files.length, 2);
          const diff = await (
            await req(`/api/jobs/${root.id}/diff?limit=16`)
          ).json();
          assert.equal(diff.diff.length, 16);
          assert.equal(diff.next_offset, 16);
          assert.equal(
            (
              await req(
                `/api/jobs/${root.id}/changes`,
                "GET",
                undefined,
                "other",
              )
            ).status,
            404,
          );
          assert.equal(
            (await req(`/api/jobs/${root.id}/diff?limit=100000`)).status,
            400,
          );
          assert.equal(
            (
              await req(
                `/api/jobs/${root.id}/revisions`,
                "POST",
                { instructions: "Denied" },
                "reader",
              )
            ).status,
            403,
          );
          assert.equal(
            (await req(`/api/jobs/${root.id}/merge`, "POST", {})).status,
            404,
          );
        },
      );
      let revision: any;
      await t.test(
        "revisions serialize per branch and update the original PR with execution and cumulative diffs",
        async () => {
          const request = randomUUID(),
            body = {
              instructions: "Revise existing changes",
              acceptance_criteria: "Checks pass",
            };
          const a = await req(
            `/api/jobs/${root.id}/revisions`,
            "POST",
            body,
            "submitter",
            request,
          );
          assert.equal(a.status, 201);
          revision = (await a.json()).job;
          assert.equal(
            (
              await (
                await req(
                  `/api/jobs/${root.id}/revisions`,
                  "POST",
                  body,
                  "submitter",
                  request,
                )
              ).json()
            ).job.id,
            revision.id,
          );
          const otherRevision = (
            await (
              await req(`/api/jobs/${root.id}/revisions`, "POST", {
                instructions: "One more",
              })
            ).json()
          ).job;
          const claims = await Promise.all(
            Array.from({ length: 6 }, () => call("/api/claim", {})),
          );
          assert.equal(claims.filter((c) => c.job).length, 1);
          const job = claims.find((c) => c.job)!.job;
          assert.equal(job.id, revision.id);
          const outcome = await run(job);
          assert.equal(outcome.action, "completed", JSON.stringify(outcome));
          assert.notEqual(outcome.result.head_commit, firstHead);
          assert.equal((outcome.result.pull_request as any).number, 42);
          assert.equal(fake.creates, 1);
          const history = await (
            await req(`/api/jobs/${root.id}/revisions`)
          ).json();
          assert.equal(history.jobs.length, 3);
          const attempt = await (
            await req(`/api/jobs/${revision.id}/executions`)
          ).json();
          assert.equal(attempt.executions[0].starting_commit, firstHead);
          assert.equal(attempt.executions[0].status, "completed");
          const delta = await (
              await req(`/api/jobs/${revision.id}/diff`)
            ).json(),
            cumulative = await (
              await req(`/api/jobs/${revision.id}/diff?kind=pull_request`)
            ).json();
          assert.match(delta.diff, /-execution 1/);
          assert.match(cumulative.diff, /-before/);
          // Retire the extra queued revision to keep later cases focused.
          await db!.query(
            `UPDATE orchestrator.jobs SET status='blocked',completed_at=clock_timestamp(),error='Test cancellation' WHERE id=$1`,
            [otherRevision.id],
          );
          assert.equal(
            await remoteHead(f.repo, f.remote, "main", undefined, true),
            f.start,
          );
        },
      );
      await t.test(
        "failed verification retains changes and publishes nothing",
        async () => {
          // Independent publication uses a fresh fake GitHub instance because it models one PR branch.
          const independentFake = fakeGitHub(f, security),
            old = deps.github;
          deps.github = independentFake.github;
          const j = await submit();
          failVerification = true;
          const { job } = await call("/api/claim", {});
          assert.equal(job.id, j.id);
          const outcome = await run(job);
          assert.equal(outcome.action, "failed");
          assert.equal((outcome.result as any).verification.status, "failed");
          assert.equal(independentFake.creates, 0);
          assert.equal(
            await remoteHead(
              f.repo,
              f.remote,
              job.publication.branch,
              undefined,
              true,
            ),
            null,
          );
          assert.ok(
            await readFile(
              join(
                f.config.storage_root,
                "worktrees",
                f.project.id,
                j.id,
                "new.txt",
              ),
            ),
          );
          failVerification = false;
          deps.github = old;
        },
      );
      await t.test(
        "push then GitHub failure can be reconciled without another Codex execution or duplicate PR",
        async () => {
          const isolated = fakeGitHub(f, security),
            old = deps.github;
          deps.github = isolated.github;
          const j = await submit(),
            { job } = await call("/api/claim", {});
          assert.equal(job.id, j.id);
          isolated.failPatch(true);
          const outcome = await run(job);
          assert.equal(outcome.action, "failed");
          const before = executions;
          isolated.failPatch(false);
          // Administrator requeues publication recovery, preserving prior immutable attempt records.
          await db!.query(
            `UPDATE orchestrator.jobs SET status='queued',completed_at=NULL WHERE id=$1`,
            [j.id],
          );
          const { job: reclaimed } = await call("/api/claim", {});
          assert.equal(reclaimed.attempt_count, 2);
          const recovered = await run(reclaimed);
          assert.equal(
            recovered.action,
            "completed",
            JSON.stringify(recovered),
          );
          assert.equal(executions, before);
          assert.equal(isolated.creates, 1);
          const attempts = (
            await (await req(`/api/jobs/${j.id}/executions`)).json()
          ).executions;
          assert.deepEqual(
            attempts.map((v: any) => v.status),
            ["failed", "completed"],
          );
          deps.github = old;
        },
      );
      await t.test(
        "lost worker checkpoints reclaim leases and reconcile without repeating Codex",
        async () => {
          for (const checkpoint of [
            "verified",
            "committed",
            "pushed",
            "published",
          ]) {
            const isolated = fakeGitHub(f, security),
              old = deps.github;
            deps.github = isolated.github;
            const created = await submit(),
              { job } = await call("/api/claim", {});
            assert.equal(job.id, created.id);
            let interrupted = false;
            const flaky: Call = async (path, body) => {
              const response = await call(path, body);
              if (
                !interrupted &&
                (body as any)?.publication_state === checkpoint
              ) {
                interrupted = true;
                if (checkpoint === "committed") {
                  const statePath = join(
                    f.config.storage_root,
                    "executions",
                    f.project.id,
                    job.id + ".json",
                  );
                  const state = JSON.parse(await readFile(statePath, "utf8"));
                  state.stage = "verified";
                  delete state.head;
                  await writeFile(statePath, JSON.stringify(state));
                }
                throw Error("Lost checkpoint response");
              }
              return response;
            };
            await assert.rejects(
              executeDevelopment(
                job,
                flaky,
                join(f.dir, "worker"),
                () => false,
                async () => {},
                deps,
              ),
            );
            const before = executions;
            await db!.query(
              "UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [job.id],
            );
            const { job: recovered } = await call("/api/claim", {});
            assert.equal(recovered.attempt_count, 2);
            const outcome = await run(recovered);
            assert.equal(outcome.action, "completed", JSON.stringify(outcome));
            assert.equal(executions, before);
            assert.equal(isolated.creates, 1);
            const attempts = (
              await (await req(`/api/jobs/${job.id}/executions`)).json()
            ).executions;
            assert.deepEqual(
              attempts.map((v: any) => v.status),
              ["interrupted", "completed"],
            );
            deps.github = old;
          }
        },
      );
      await t.test(
        "worker rejects base publication targets before attempting a push",
        async () => {
          for (const target of ["main", "conduit/job-approved-base"]) {
            const created = await submit(),
              { job } = await call("/api/claim", {});
            assert.equal(job.id, created.id);
            const originalPush = deps.network!.push;
            let pushes = 0;
            deps.network!.push = async (...args) => {
              pushes++;
              return originalPush(...args);
            };
            try {
              const outcome = await run({
                ...job,
                publication: { ...job.publication, branch: target },
                project_record: {
                  ...job.project_record,
                  allowed_base_branches: ["main", "conduit/job-approved-base"],
                },
              });
              assert.equal(outcome.action, "blocked");
              assert.equal(pushes, 0);
              assert.equal(
                await remoteHead(f.repo, f.remote, "main", undefined, true),
                f.start,
              );
            } finally {
              deps.network!.push = originalPush;
            }
          }
        },
      );
      await t.test(
        "a held local branch lock blocks execution without changing files",
        async () => {
          const created = await submit(),
            { job } = await call("/api/claim", {});
          assert.equal(job.id, created.id);
          const dir = join(f.config.storage_root, "locks", f.project.id);
          await mkdir(dir, { recursive: true });
          const lock = join(dir, job.root_job_id + ".lock");
          await writeFile(lock, JSON.stringify({ pid: process.pid }));
          const before = executions;
          const outcome = await run(job);
          assert.equal(outcome.action, "blocked");
          assert.equal(executions, before);
          assert.ok(await readFile(lock));
          await rm(lock);
        },
      );
      await t.test(
        "unexpected revision remote head blocks before Codex and never force-pushes",
        async () => {
          const response = await req(`/api/jobs/${root.id}/revisions`, "POST", {
            instructions: "Should not run after outside push",
          });
          assert.equal(response.status, 201);
          const revision = (await response.json()).job,
            { job } = await call("/api/claim", {});
          assert.equal(job.id, revision.id);
          const oldHead = await remoteHead(
            f.repo,
            f.remote,
            job.publication.branch,
            undefined,
            true,
          );
          const tree = (
            await git(f.repo, ["rev-parse", `${oldHead}^{tree}`])
          ).trim();
          const external = (
            await git(f.repo, [
              "-c",
              "user.name=Human",
              "-c",
              "user.email=human@example.invalid",
              "commit-tree",
              tree,
              "-p",
              oldHead!,
              "-m",
              "Outside push",
            ])
          ).trim();
          await safePush(
            f.repo,
            f.remote,
            job.publication.branch,
            external,
            oldHead,
            undefined,
            true,
          );
          const before = executions,
            outcome = await run(job);
          assert.equal(outcome.action, "blocked");
          assert.equal(executions, before);
          assert.equal(
            await remoteHead(
              f.repo,
              f.remote,
              job.publication.branch,
              undefined,
              true,
            ),
            external,
          );
        },
      );
      await t.test(
        "dependencies wait for actual merge, reject invalid edges, and disabled projects cannot execute",
        async () => {
          const dependent = await submit({ dependency_job_ids: [root.id] });
          assert.equal(dependent.status, "waiting_dependencies");
          assert.equal((await call("/api/claim", {})).job, null);
          // Reconciliation, not successful execution, opens this gate.
          await call("/api/development/reconcile", {
            root_job_id: root.id,
            pull_request: {
              number: 42,
              url: "https://github.com/example/disposable/pull/42",
              draft: true,
              state: "closed",
              merged: true,
              head: fake.pr.head.sha,
            },
          });
          const { job } = await call("/api/claim", {});
          assert.equal(job.id, dependent.id);
          await call(`/api/jobs/${job.id}/report`, {
            claim_token: job.claim_token,
            action: "blocked",
            error: "End test",
          });
          const disabled = await submit();
          const { job: activeDisabled } = await call("/api/claim", {});
          assert.equal(activeDisabled.id, disabled.id);
          const queuedDisabled = await submit();
          await db!.query(
            "UPDATE orchestrator.projects SET enabled=false WHERE id=$1",
            [f.project.id],
          );
          assert.equal((await req("/api/jobs", "POST", input)).status, 400);
          assert.equal(
            (
              await req(
                `/api/jobs/${disabled.id}/publication`,
                "POST",
                {
                  claim_token: activeDisabled.claim_token,
                  phase: "publishing",
                },
                "worker",
              )
            ).status,
            409,
          );
          await db!.query(
            "UPDATE orchestrator.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [disabled.id],
          );
          assert.equal((await call("/api/claim", {})).job, null);
          assert.equal(
            (await (await req(`/api/jobs/${queuedDisabled.id}`)).json()).job
              .status,
            "blocked",
          );
          assert.equal(
            (await (await req(`/api/jobs/${disabled.id}`)).json()).job.status,
            "blocked",
          );
        },
      );
      await t.test(
        "stale attempt cannot write artifacts or publication metadata",
        async () => {
          assert.equal(
            (
              await req(
                `/api/jobs/${revision.id}/publication`,
                "POST",
                { claim_token: randomUUID(), head_commit: f.start },
                "worker",
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await req(
                `/api/jobs/${revision.id}/artifacts`,
                "POST",
                {
                  claim_token: randomUUID(),
                  kind: "execution",
                  files: [],
                  diff: "",
                },
                "worker",
              )
            ).status,
            409,
          );
        },
      );
    } finally {
      await runtime?.end();
      await db?.end();
      await postgres.stop().catch(() => {});
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
