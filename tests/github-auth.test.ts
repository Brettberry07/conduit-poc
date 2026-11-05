import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../worker/development/github";
import {
  githubCliToken,
  githubCredentialPaths,
  loadGitHubCredentials,
} from "../worker/development/github-auth";
import type { GitHubSecurity } from "../worker/development/github-policy";

const prototype: GitHubSecurity = {
  policy: "prototype",
  acknowledge_prototype_risk: true,
  approved_repositories: ["example/disposable"],
};
test("prototype loads local gh authentication without an audit credential; strict never falls back to gh", async () => {
  let calls = 0;
  const cli = async () => {
    calls++;
    return "gho_TEST_ONLY";
  };
  assert.deepEqual(
    await loadGitHubCredentials(
      prototype,
      { CONDUIT_GITHUB_POLICY_TOKEN_FILE: "/missing/unused-audit" },
      cli,
    ),
    { token: "gho_TEST_ONLY", policyToken: undefined },
  );
  await assert.rejects(
    loadGitHubCredentials({ policy: "strict_bot" }, {}, cli),
    /CONDUIT_GITHUB_TOKEN_FILE/,
  );
  assert.equal(calls, 1);
});
test("configured PAT files take precedence, require private permissions, and never silently fall back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-github-auth-"));
  let calls = 0;
  try {
    const path = join(dir, "token");
    const cli = async () => {
      calls++;
      throw Error("CLI must not be used");
    };
    for (const token of ["ghp_TEST_ONLY", "github_pat_TEST_ONLY"]) {
      await writeFile(path, token + "\n", { mode: 0o600 });
      const credentials = await loadGitHubCredentials(
        prototype,
        { CONDUIT_GITHUB_TOKEN_FILE: path },
        cli,
      );
      assert.equal(credentials.token, token);
      assert.equal(
        new GitHub(
          credentials.token,
          undefined,
          undefined,
          prototype,
        ).gitToken(),
        token,
      );
    }
    await chmod(path, 0o644);
    await assert.rejects(
      loadGitHubCredentials(
        prototype,
        { CONDUIT_GITHUB_TOKEN_FILE: path },
        cli,
      ),
      /mode-600/,
    );
    await assert.rejects(
      loadGitHubCredentials(prototype, { CONDUIT_GITHUB_TOKEN_FILE: dir }, cli),
      /mode-600/,
    );
    await assert.rejects(
      loadGitHubCredentials(
        prototype,
        { CONDUIT_GITHUB_TOKEN_FILE: join(dir, "missing") },
        cli,
      ),
    );
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("strict loads the optional read-only fine-grained audit token and rejects classic audit credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-github-audit-"));
  try {
    const token = join(dir, "token"),
      audit = join(dir, "audit");
    await writeFile(token, "github_pat_TEST_ONLY", { mode: 0o600 });
    await writeFile(audit, "github_pat_AUDIT_ONLY", { mode: 0o600 });
    const env = {
      CONDUIT_GITHUB_TOKEN_FILE: token,
      CONDUIT_GITHUB_POLICY_TOKEN_FILE: audit,
    };
    assert.deepEqual(
      await loadGitHubCredentials({ policy: "strict_bot" }, env),
      { token: "github_pat_TEST_ONLY", policyToken: "github_pat_AUDIT_ONLY" },
    );
    await chmod(audit, 0o644);
    await assert.rejects(
      loadGitHubCredentials({ policy: "strict_bot" }, env),
      /mode-600/,
    );
    await chmod(audit, 0o600);
    await writeFile(audit, "ghp_CLASSIC_TEST_ONLY");
    await assert.rejects(
      loadGitHubCredentials({ policy: "strict_bot" }, env),
      /fine-grained read-only/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("gh authentication uses fixed argv, a scrubbed environment, bounded output and sanitized errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-gh-command-"));
  try {
    const capture = join(dir, "capture.json"),
      executable = join(dir, "gh");
    await writeFile(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env })); process.stdout.write('gho_SYNTHETIC_TEST_ONLY\\n');`,
      { mode: 0o700 },
    );
    const env = {
      PATH: dir,
      GH_CONFIG_DIR: join(dir, "config"),
      GH_TOKEN: "ghp_MUST_NOT_INHERIT",
      GITHUB_TOKEN: "ghp_MUST_NOT_INHERIT",
      GH_DEBUG: "api",
      NODE_OPTIONS: "--invalid-option",
      WORKER_KEY_FILE: "/private/worker",
    };
    assert.equal(await githubCliToken(env), "gho_SYNTHETIC_TEST_ONLY");
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    assert.deepEqual(recorded.argv, [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
    assert.equal(recorded.env.GH_CONFIG_DIR, env.GH_CONFIG_DIR);
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_DEBUG",
      "NODE_OPTIONS",
      "WORKER_KEY_FILE",
    ])
      assert.equal(recorded.env[key], undefined);
    assert.ok(githubCredentialPaths(env).includes(env.GH_CONFIG_DIR));
    assert.ok(
      githubCredentialPaths({ XDG_CONFIG_HOME: dir }).includes(join(dir, "gh")),
    );
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stderr.write('ghp_SENSITIVE_ERROR'); process.stdout.write('ghp_SENSITIVE_OUTPUT'); process.exit(1);`,
    );
    await assert.rejects(githubCliToken(env), (error) => {
      assert.match(String(error), /authentication unavailable/);
      assert.equal(String(error).includes("SENSITIVE"), false);
      assert.equal((error as any).stdout, undefined);
      assert.equal((error as any).stderr, undefined);
      return true;
    });
    await assert.rejects(
      githubCliToken({ PATH: "/nonexistent" }),
      /authentication unavailable/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
