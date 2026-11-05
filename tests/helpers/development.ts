import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GitHubSecurity } from "../../worker/development/github-policy";
import { GitHub, type Project } from "../../worker/development/github";
import {
  git,
  remoteHead,
  type LocalProject,
} from "../../worker/development/git";
export async function fixture() {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "conduit-git-test-")),
    ),
    repo = join(dir, "checkout"),
    remote = join(dir, "remote.git");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "modified.txt"), "before\n");
  await writeFile(join(repo, "deleted.txt"), "delete\n");
  await writeFile(join(repo, "rename.txt"), "rename this exact line\n");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  await git(dir, ["clone", "--bare", "--", repo, remote], undefined, true);
  await git(repo, [
    "remote",
    "add",
    "origin",
    "https://github.com/example/disposable.git",
  ]);
  const start = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const project: Project = {
    id: randomUUID(),
    name: "Disposable",
    repository_owner: "example",
    repository_name: "disposable",
    repository_url: "https://github.com/example/disposable.git",
    default_branch: "main",
    allowed_base_branches: ["main"],
    enabled: true,
  };
  const config: LocalProject = {
    project_id: project.id,
    mode: "existing",
    repository_path: repo,
    storage_root: join(dir, "storage"),
    remote: "origin",
    verification: [
      { name: "test", argv: [process.execPath, "--test"], timeout_ms: 30000 },
    ],
    policy: { allowed_paths: ["*"], read_only_paths: [] },
  };
  return { dir, repo, remote, start, project, config };
}
export function fakeGitHub(
  f: Awaited<ReturnType<typeof fixture>>,
  security: GitHubSecurity = { policy: "strict_bot" },
) {
  let raw: any,
    createCount = 0,
    lostCreate = false,
    failPatch = false,
    unsafe = false,
    closed = false,
    ready = false;
  const calls: { method: string; path: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/repos/example/disposable", ""),
      method = init?.method ?? "GET";
    calls.push({ method, path });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const response = (v: any, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "")
      return response({
        full_name: "example/disposable",
        default_branch: "main",
        owner: { login: "example", type: "User" },
        archived: false,
        permissions: {
          pull: true,
          push: true,
          admin: security.policy === "prototype",
          maintain: false,
        },
        allow_auto_merge: unsafe,
      });
    if (path === "/user") return response({ login: "example" });
    if (path === "/branches/main")
      return response({
        name: "main",
        protected: security.policy === "strict_bot",
      });
    if (path === "/branches/main/protection") return response({}, 404);
    if (path.startsWith("/rules/branches/"))
      return response([
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "update", ruleset_id: 1, ruleset_source_type: "Repository" },
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 1 },
        },
      ]);
    if (path === "/rulesets/1")
      return response({
        enforcement: "active",
        bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5 }],
        rules: [{ type: "update" }],
      });
    if (raw) {
      raw.state = closed ? "closed" : "open";
      raw.draft = !ready;
      raw.head.sha = await remoteHead(
        f.repo,
        f.remote,
        raw.head.ref,
        undefined,
        true,
      );
    }
    if (path === "/pulls" && method === "GET")
      return response(raw ? [raw] : []);
    if (path === "/pulls" && method === "POST") {
      createCount++;
      assert.equal(body.draft, true);
      assert.equal(body.maintainer_can_modify, false);
      raw = {
        number: 42,
        html_url: "https://github.com/example/disposable/pull/42",
        draft: true,
        state: "open",
        merged: false,
        head: {
          ref: body.head,
          sha: await remoteHead(f.repo, f.remote, body.head, undefined, true),
        },
        base: { ref: body.base },
      };
      if (lostCreate) {
        lostCreate = false;
        throw Error("lost create response");
      }
      return response(raw, 201);
    }
    if (path === "/pulls/42" && method === "PATCH") {
      if (failPatch) return response({}, 503);
      raw.body = body.body;
      return response(raw);
    }
    if (path === "/pulls/42" && method === "GET") return response(raw);
    throw Error("Unexpected GitHub call " + method + " " + path);
  };
  return {
    github: new GitHub("github_pat_TEST_ONLY", transport, undefined, security),
    calls,
    get creates() {
      return createCount;
    },
    get pr() {
      return raw;
    },
    loseCreate() {
      lostCreate = true;
    },
    failPatch(value: boolean) {
      failPatch = value;
    },
    unsafe(value: boolean) {
      unsafe = value;
    },
    close() {
      closed = true;
    },
    ready() {
      ready = true;
    },
  };
}
