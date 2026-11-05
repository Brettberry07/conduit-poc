import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { featureBranch, branchSchema } from "../src/lib/development";
import { GitHub, Blocked, type Project } from "../worker/development/github";
import {
  git,
  localProjectSchema,
  validateRepository,
  initializeRepository,
  createWorktree,
  fetchBranch,
  remoteHead,
  safePush,
  permitted,
  matchesRepository,
  obviousSecret,
  type LocalProject,
} from "../worker/development/git";
import { captureChanges, commitChanges } from "../worker/development/changes";
import { validateRegistration } from "../scripts/project";
import { fixture, fakeGitHub } from "./helpers/development";
// Exported fixtures are consumed by development-flow.test.ts; test registration is kept local.
test("branch naming is sanitized, bounded and collision resistant", () => {
  const a = featureBranch(randomUUID(), "../../Feature $HOME; 😀"),
    b = featureBranch(randomUUID(), "../../Feature $HOME; 😀");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("conduit/job-"));
  branchSchema.parse(a);
  for (const bad of [
    "-main",
    "../main",
    "refs//main",
    "main.lock",
    "a/../b",
    "a/.hidden",
  ])
    assert.equal(branchSchema.safeParse(bad).success, false);
});
test("repository and workspace policies reject credentials, traversal and workflow changes", () => {
  const policy = {
    allowed_paths: ["src/", "README.md"],
    read_only_paths: ["src/locked.ts"],
  };
  for (const path of [
    "../outside",
    "/tmp/file",
    ".env",
    ".env.production",
    "src/.env.local",
    "src/credentials.json",
    ".github/workflows/push.yml",
    "src/locked.ts",
  ])
    assert.equal(permitted(path, policy), false, path);
  assert.equal(permitted("src/index.ts", policy), true);
  assert.equal(
    matchesRepository("https://token@github.com/example/disposable.git", {
      repository_owner: "example",
      repository_name: "disposable",
    } as Project),
    false,
  );
  assert.equal(obviousSecret("github_pat_" + "x".repeat(40)), true);
});
test("worktrees preserve dirty checkout, detect actual changes including renames, commit and push independently", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "modified.txt"), "staged\n");
    await git(f.repo, ["add", "modified.txt"]);
    await writeFile(join(f.repo, "modified.txt"), "unstaged\n");
    await writeFile(join(f.repo, "local-only.txt"), "private user file\n");
    const before = await git(f.repo, ["status", "--porcelain=v1", "-z"]),
      index = await readFile(join(f.repo, ".git/index"));
    await validateRepository(f.repo, f.project);
    const branch = featureBranch(randomUUID(), "First task"),
      workspace = join(f.dir, "worktree");
    await createWorktree(f.repo, workspace, branch, f.start);
    await writeFile(join(workspace, "modified.txt"), "after\n");
    await rm(join(workspace, "deleted.txt"));
    await rename(join(workspace, "rename.txt"), join(workspace, "renamed.txt"));
    await writeFile(join(workspace, "untracked.txt"), "added\n");
    const changes = await captureChanges(workspace, f.start, f.config.policy);
    assert.equal(changes.files.length, 4);
    assert.deepEqual(
      new Set(changes.files.map((v) => v.status)),
      new Set(["added", "modified", "deleted", "renamed"]),
    );
    const added = changes.files.find((v) => v.path === "untracked.txt");
    assert.equal(added?.additions, 1);
    assert.match(changes.diff, /\+added/);
    const renamed = changes.files.find((v) => v.status === "renamed");
    assert.equal(renamed?.old_path, "rename.txt");
    assert.equal(renamed?.path, "renamed.txt");
    const head = await commitChanges(
      workspace,
      branch,
      f.start,
      changes,
      "Test change",
    );
    assert.equal((await git(workspace, ["status", "--porcelain"])).trim(), "");
    await safePush(f.repo, f.remote, branch, head, null, undefined, true);
    assert.equal(
      await remoteHead(f.repo, f.remote, branch, undefined, true),
      head,
    );
    const independent = join(f.dir, "second-worktree"),
      branch2 = featureBranch(randomUUID(), "Second task");
    await createWorktree(f.repo, independent, branch2, f.start);
    assert.equal(
      await readFile(join(independent, "modified.txt"), "utf8"),
      "before\n",
    );
    assert.equal(await git(f.repo, ["status", "--porcelain=v1", "-z"]), before);
    assert.deepEqual(await readFile(join(f.repo, ".git/index")), index);
    assert.equal(
      (await git(f.repo, ["symbolic-ref", "--short", "HEAD"])).trim(),
      "main",
    );
    assert.equal(
      await readFile(join(f.repo, "local-only.txt"), "utf8"),
      "private user file\n",
    );
    await assert.rejects(
      safePush(f.repo, f.remote, branch, head, f.start, undefined, true),
      Blocked,
    );
    await assert.rejects(
      safePush(f.repo, f.remote, "main", head, f.start, undefined, true),
      Blocked,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("secret, symlink and oversized changes never become review artifacts or commits", async () => {
  const f = await fixture();
  try {
    for (const kind of ["secret", "symlink", "oversized", "prohibited"]) {
      const workspace = join(f.dir, kind);
      await createWorktree(
        f.repo,
        workspace,
        featureBranch(randomUUID(), kind),
        f.start,
      );
      if (kind === "secret")
        await writeFile(
          join(workspace, "bad.txt"),
          "github_pat_" + "z".repeat(40),
        );
      if (kind === "symlink")
        await symlink("/etc/passwd", join(workspace, "bad.txt"));
      if (kind === "oversized")
        await writeFile(join(workspace, "bad.txt"), "a".repeat(300000));
      if (kind === "prohibited")
        await writeFile(join(workspace, ".env"), "TEST=value");
      await assert.rejects(
        captureChanges(workspace, f.start, f.config.policy),
        Blocked,
      );
      assert.equal(
        (await git(workspace, ["rev-parse", "HEAD"])).trim(),
        f.start,
      );
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("managed initialization clones persistently; registration refuses wrong remotes and unsafe GitHub policy", async () => {
  const f = await fixture();
  try {
    const fake = fakeGitHub(f);
    await fake.github.safety(f.project);
    fake.unsafe(true);
    await assert.rejects(fake.github.safety(f.project), Blocked);
    fake.unsafe(false);
    const runGit: typeof git = async (cwd, args, token, allowLocal, env) => {
      const redirected = args.map((a) =>
        a === f.project.repository_url ? f.remote : a,
      );
      const result = await git(cwd, redirected, undefined, true, env);
      if (args[0] === "clone")
        await git(args.at(-1)!, [
          "config",
          "remote.origin.url",
          f.project.repository_url,
        ]);
      return result;
    };
    const managed = {
      ...f.config,
      mode: "managed" as const,
      repository_path: undefined,
    };
    const path = await initializeRepository(
      managed,
      f.project,
      undefined,
      runGit,
    );
    assert.equal(
      (await git(path, ["rev-parse", "--is-bare-repository"])).trim(),
      "true",
    );
    assert.equal(
      await initializeRepository(managed, f.project, undefined, runGit),
      path,
    );
    const raw = {
      id: f.project.id,
      name: f.project.name,
      repository_owner: "example",
      repository_name: "wrong",
      default_branch: "main",
      allowed_base_branches: ["main"],
      local: { ...f.config, project_id: undefined },
    };
    await assert.rejects(validateRegistration(raw, fake.github));
    await git(f.repo, [
      "config",
      "remote.origin.url",
      "https://github.com/attacker/wrong.git",
    ]);
    await assert.rejects(validateRepository(f.repo, f.project), Blocked);
    assert.equal(
      localProjectSchema.safeParse({
        ...f.config,
        mode: "existing",
        repository_path: undefined,
      }).success,
      false,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("hidden ruleset bypass actors require a separate read-only policy credential and cannot use it for mutations", async () => {
  const f = await fixture();
  try {
    const transport: typeof fetch = async (_input, init) => {
      const url = String(_input),
        isAudit =
          (init?.headers as Record<string, string>).Authorization ===
          "Bearer github_pat_POLICY_READ_ONLY";
      const respond = (v: unknown) =>
        new Response(JSON.stringify(v), {
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith("/repos/example/disposable"))
        return respond({
          full_name: "example/disposable",
          default_branch: "main",
          permissions: { push: true, admin: false, maintain: false },
          allow_auto_merge: false,
        });
      if (url.includes("/rules/branches/"))
        return respond([
          { type: "update", ruleset_id: 1, ruleset_source_type: "Repository" },
          {
            type: "pull_request",
            parameters: { required_approving_review_count: 1 },
          },
        ]);
      assert.ok(url.endsWith("/rulesets/1"));
      assert.equal(init?.method, "GET");
      return respond({
        enforcement: "active",
        rules: [{ type: "update" }],
        ...(isAudit
          ? { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5 }] }
          : {}),
      });
    };
    await assert.rejects(
      new GitHub("github_pat_BOT_ONLY", transport).safety(f.project),
      Blocked,
    );
    const github = new GitHub(
      "github_pat_BOT_ONLY",
      transport,
      "github_pat_POLICY_READ_ONLY",
    );
    await github.safety(f.project);
    await assert.rejects(
      github.request(f.project, "/rulesets/1", "PUT", {}, true),
      /restricted to reading/,
    );
    await assert.rejects(
      github.request(f.project, "/pulls", "GET", undefined, true),
      /restricted to reading/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
