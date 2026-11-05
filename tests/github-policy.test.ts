import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, Blocked, type Project } from "../worker/development/github";
import {
  githubSecuritySchema,
  loadGitHubSecurity,
  type GitHubSecurity,
} from "../worker/development/github-policy";
import { assertDisposableTarget } from "../scripts/github-smoke";
import { registrationSchema } from "../scripts/project";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Disposable",
  repository_owner: "example",
  repository_name: "disposable",
  repository_url: "https://github.com/example/disposable.git",
  default_branch: "main",
  allowed_base_branches: ["main"],
  enabled: true,
};
const prototype: GitHubSecurity = {
  policy: "prototype",
  acknowledge_prototype_risk: true,
  approved_repositories: ["example/disposable"],
};
function fixture(
  security: GitHubSecurity = prototype,
  token = "ghp_TEST_ONLY",
) {
  const repo: any = {
    full_name: "example/disposable",
    owner: { login: "example", type: "User" },
    default_branch: "main",
    archived: false,
    // Prototype must not require the administrator to change repository settings.
    allow_auto_merge: true,
    permissions: { pull: true, push: true, admin: true, maintain: true },
  };
  const branch: any = { name: "main", protected: false };
  let rules: any[] = [];
  const ruleset: any = {
    enforcement: "active",
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5 }],
    rules: [{ type: "update" }],
  };
  const failures = new Map<string, number>();
  const calls: { path: string; method: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? "GET" });
    if (failures.has(path))
      return new Response("{}", { status: failures.get(path) });
    let value: unknown;
    if (path === "/repos/example/disposable") value = repo;
    else if (path === "/repos/example/disposable/branches/main") value = branch;
    else if (path === "/repos/example/disposable/rules/branches/main")
      value = rules;
    else if (path === "/repos/example/disposable/rulesets/1") value = ruleset;
    else throw Error("Unexpected mocked GitHub request");
    return new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    github: new GitHub(token, transport, undefined, security),
    repo,
    branch,
    calls,
    failures,
    ruleset,
    setRules(value: any[]) {
      rules = value;
    },
  };
}

test("strict policy continues to reject owner/admin and maintain identities without falling back", async () => {
  for (const permission of ["admin", "maintain"]) {
    const f = fixture({ policy: "strict_bot" }, "github_pat_TEST_ONLY");
    f.repo.allow_auto_merge = false;
    f.repo.permissions.admin = false;
    f.repo.permissions.maintain = false;
    f.repo.permissions[permission] = true;
    await assert.rejects(f.github.safety(project), /strict_bot rejects/);
    assert.equal(f.calls.length, 1);
  }
});
test("strict mode still requires verifiable update restrictions, approvals and disabled auto-merge", async () => {
  const f = fixture({ policy: "strict_bot" }, "github_pat_TEST_ONLY");
  f.repo.permissions.admin = false;
  f.repo.permissions.maintain = false;
  await assert.rejects(f.github.safety(project), /auto-merge policy/);
  f.repo.allow_auto_merge = false;
  const update = {
    type: "update",
    ruleset_id: 1,
    ruleset_source_type: "Repository",
  };
  const review = {
    type: "pull_request",
    parameters: { required_approving_review_count: 1 },
  };
  for (const rules of [
    [],
    [update],
    [review],
    [update, { ...review, parameters: { required_approving_review_count: 0 } }],
  ]) {
    f.setRules(rules);
    await assert.rejects(f.github.safety(project), /update restriction/);
  }
  f.setRules([update, review]);
  assert.deepEqual(await f.github.safety(project), {
    policy: "strict_bot",
    warnings: [],
  });
  f.ruleset.bypass_actors.push({ actor_type: "Integration", actor_id: 123 });
  await assert.rejects(f.github.safety(project), /update restriction/);
  f.failures.set("/repos/example/disposable/rules/branches/main", 403);
  await assert.rejects(f.github.safety(project), /403/);
});
test("prototype opt-in requires a private local file, explicit acknowledgement and exact allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-policy-"));
  try {
    const path = join(dir, "security.json");
    assert.deepEqual(await loadGitHubSecurity(""), { policy: "strict_bot" });
    await writeFile(path, JSON.stringify(prototype), { mode: 0o600 });
    assert.deepEqual(await loadGitHubSecurity(path), prototype);
    await chmod(path, 0o644);
    await assert.rejects(loadGitHubSecurity(path), /mode-600/);
    await chmod(path, 0o600);
    for (const invalid of [
      { policy: "typo" },
      { policy: "prototype" },
      { ...prototype, acknowledge_prototype_risk: false },
      { ...prototype, approved_repositories: [] },
      { ...prototype, approved_repositories: ["example/*"] },
      { ...prototype, minimum_required_approvals: 0 },
      { policy: "prototype_owner_token" },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(loadGitHubSecurity(path), /no fallback/);
    }
    await assert.rejects(loadGitHubSecurity(join(dir, "missing.json")));
    assert.equal(
      githubSecuritySchema.safeParse({
        policy: "strict_bot",
        approved_repositories: ["example/disposable"],
      }).success,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("prototype accepts owner identity, classic/fine-grained/CLI tokens, and unprotected bases without policy audits", async () => {
  for (const token of [
    "ghp_TEST_ONLY",
    "github_pat_TEST_ONLY",
    "gho_TEST_ONLY",
  ]) {
    const f = fixture(prototype, token);
    // Unsupported/unreadable rules must not block prototype registration or publication.
    f.failures.set("/repos/example/disposable/rules/branches/main", 403);
    const result = await f.github.safety(project);
    assert.equal(result.policy, "prototype");
    assert.match(result.warnings[0], /development only.*may retain merge/);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.deepEqual(
      f.calls.map((c) => c.path),
      ["/repos/example/disposable", "/repos/example/disposable/branches/main"],
    );
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
  for (const token of ["ghp_TEST_ONLY", "gho_TEST_ONLY"])
    assert.throws(() => new GitHub(token), /fine-grained/);
  for (const token of ["", "invalid", "ghp_SECRET\nleak", "ghp_SECRET secret"])
    assert.throws(
      () => new GitHub(token, undefined, undefined, prototype),
      /Prototype requires/,
    );
});
test("prototype rejects repositories outside the local allowlist before any GitHub request", async () => {
  const f = fixture({ ...prototype, approved_repositories: ["example/other"] });
  await assert.rejects(f.github.safety(project), /allowlist/);
  await assert.rejects(f.github.read(project, 42), /allowlist/);
  assert.equal(f.calls.length, 0);
  const allowed = fixture({
    ...prototype,
    approved_repositories: ["EXAMPLE/DISPOSABLE"],
  });
  await allowed.github.safety(project);
});
test("prototype retains repository identity, permissions, archive, default and approved base checks", async (t) => {
  for (const [name, mutate] of [
    [
      "wrong identity",
      (f: ReturnType<typeof fixture>) => {
        f.repo.full_name = "attacker/other";
      },
    ],
    [
      "archived",
      (f: ReturnType<typeof fixture>) => {
        f.repo.archived = true;
      },
    ],
    [
      "unknown archive state",
      (f: ReturnType<typeof fixture>) => {
        delete f.repo.archived;
      },
    ],
    [
      "no write permission",
      (f: ReturnType<typeof fixture>) => {
        f.repo.permissions.push = false;
      },
    ],
    [
      "unknown read permission",
      (f: ReturnType<typeof fixture>) => {
        delete f.repo.permissions.pull;
      },
    ],
    [
      "default changed",
      (f: ReturnType<typeof fixture>) => {
        f.repo.default_branch = "other";
      },
    ],
    [
      "wrong base",
      (f: ReturnType<typeof fixture>) => {
        f.branch.name = "other";
      },
    ],
  ] as const)
    await t.test(name, async () => {
      const f = fixture();
      mutate(f);
      await assert.rejects(f.github.safety(project), Blocked);
    });
  const f = fixture();
  await assert.rejects(
    f.github.safety({ ...project, enabled: false }),
    /not approved/,
  );
  await assert.rejects(
    f.github.safety({
      ...project,
      repository_url: "https://attacker.invalid/repo.git",
    }),
    Blocked,
  );
  await assert.rejects(f.github.safety(project, "other"), /not approved/);
  f.failures.set("/repos/example/disposable/branches/main", 404);
  await assert.rejects(f.github.safety(project), /404/);
});
test("publication rejects default/base targets and non-Conduit branches before any GitHub mutation", async () => {
  const f = fixture();
  for (const branch of ["main", "feature/test", "conduit/job-approved-base"])
    await assert.rejects(
      f.github.publish(
        {
          ...project,
          allowed_base_branches: ["main", "conduit/job-approved-base"],
        },
        branch,
        "main",
        "Test",
        "Test",
      ),
      /independent Conduit feature branch/,
    );
  assert.equal(f.calls.length, 0);
});
test("security policy cannot be supplied through project registration data", () => {
  const registration = {
    name: "Disposable",
    repository_owner: "example",
    repository_name: "disposable",
    default_branch: "main",
    allowed_base_branches: ["main"],
    local: {
      mode: "managed",
      storage_root: "/approved/storage",
      verification: [{ name: "test", argv: ["node", "--test"] }],
      policy: { allowed_paths: ["*"] },
    },
  };
  assert.equal(registrationSchema.safeParse(registration).success, true);
  assert.equal(
    registrationSchema.safeParse({
      ...registration,
      github_security: prototype,
    }).success,
    false,
  );
  assert.equal(
    registrationSchema.safeParse({
      ...registration,
      local: { ...registration.local, github_security: prototype },
    }).success,
    false,
  );
});
test("disposable guard accepts public/private markers and always rejects the main Conduit repository", () => {
  for (const privateRepo of [true, false]) {
    assert.throws(
      () =>
        assertDisposableTarget("Brettberry07/conduit-poc", {
          private: privateRepo,
          topics: ["conduit-disposable-test"],
        }),
      /main Conduit repository/,
    );
    assert.throws(
      () =>
        assertDisposableTarget("example/test", {
          private: privateRepo,
          topics: [],
        }),
      /topic/,
    );
    assertDisposableTarget("example/test", {
      private: privateRepo,
      topics: ["conduit-disposable-test"],
    });
  }
});
