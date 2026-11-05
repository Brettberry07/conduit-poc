import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { branchSchema } from "../../src/lib/development";
import { Blocked, type Project } from "./github";
export const localProjectSchema = z
  .object({
    project_id: z.string().uuid(),
    mode: z.enum(["managed", "existing"]),
    repository_path: z.string().optional(),
    storage_root: z.string(),
    remote: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
      .default("origin"),
    dependency_directory: z.string().optional(),
    verification: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9_-]+$/),
            argv: z.array(z.string().min(1)).min(1).max(30),
            timeout_ms: z.number().int().min(1000).max(600000).default(60000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    policy: z
      .object({
        allowed_paths: z.array(z.string().min(1)).min(1),
        read_only_paths: z
          .array(
            z
              .string()
              .refine(
                (p) =>
                  !isAbsolute(p) &&
                  !p.split("/").some((v) => v === ".." || v === "." || !v),
              ),
          )
          .default([]),
      })
      .strict(),
  })
  .strict()
  .refine(
    (p) => p.mode !== "existing" || !!p.repository_path,
    "Existing mode needs an approved repository_path",
  );
export type LocalProject = z.infer<typeof localProjectSchema>;
export async function localProjects(path = process.env.CONDUIT_PROJECTS_FILE) {
  if (!path)
    throw Error(
      "Set CONDUIT_PROJECTS_FILE to administrator-owned local project configuration",
    );
  return z
    .array(localProjectSchema)
    .parse(JSON.parse(await readFile(path, "utf8")));
}
export function safePath(path: string) {
  return (
    path.length <= 240 &&
    !isAbsolute(path) &&
    !path
      .split("/")
      .some((p) => p === ".." || p === "." || !p || /[\x00-\x1f\x7f]/.test(p))
  );
}
// Project editing excludes only environment files and SSH directories. Other
// credentials used by the controller remain outside the development sandbox.
export function prohibited(path: string) {
  return !safePath(path) || /(^|\/)(\.env(?:$|[./])|\.ssh(?:$|\/))/.test(path);
}
export function obviousSecret(text: string) {
  return /(?:cnd_live_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'](?!EXAMPLE|PLACEHOLDER|<)[A-Za-z0-9_+\/-]{20,}["'])/i.test(
    text,
  );
}
export function permitted(path: string, policy: LocalProject["policy"]) {
  return (
    !prohibited(path) &&
    !policy.read_only_paths.some(
      (p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"),
    ) &&
    policy.allowed_paths.some(
      (p) => p === "*" || path === p || (p.endsWith("/") && path.startsWith(p)),
    )
  );
}
const cleanEnv = () => ({
  NODE_ENV: "production" as const,
  PATH: "/usr/bin:/bin:/opt/homebrew/bin",
  HOME: "/var/empty",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
});
export async function git(
  cwd: string,
  args: string[],
  token?: string,
  allowLocal = false,
  extraEnv: Record<string, string | undefined> = {},
  maxOutputBytes = 4 * 1024 * 1024,
): Promise<string> {
  let authDir: string | undefined;
  try {
    let auth: Record<string, string> = {};
    if (token) {
      authDir = await mkdtemp(join(tmpdir(), "conduit-git-auth-"));
      const helper = join(authDir, "askpass");
      await writeFile(
        helper,
        '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$CONDUIT_GIT_PASSWORD" ;; esac\n',
        { mode: 0o700 },
      );
      auth = { GIT_ASKPASS: helper, CONDUIT_GIT_PASSWORD: token };
    }
    return await new Promise<string>((done, reject) => {
      let output = Buffer.alloc(0),
        failed = false;
      const child = spawn(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "credential.helper=",
          "-c",
          "http.extraHeader=",
          "-c",
          `protocol.file.allow=${allowLocal ? "always" : "never"}`,
          "-c",
          "protocol.ext.allow=never",
          ...args,
        ],
        {
          cwd,
          env: { ...cleanEnv(), ...extraEnv, ...auth },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 60000);
      child.stdout.on("data", (b: Buffer) => {
        output = Buffer.concat([output, b]);
        if (output.length > maxOutputBytes) {
          failed = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(Error("Trusted Git command could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        code === 0 && !failed
          ? done(output.toString("utf8"))
          : reject(
              Error(
                `Trusted Git ${args[0]} failed or exceeded limits; local work is preserved`,
              ),
            );
      });
    });
  } finally {
    if (authDir) await rm(authDir, { recursive: true, force: true });
  }
}
export function matchesRepository(url: string, p: Project) {
  const expected = `${p.repository_owner}/${p.repository_name}`.toLowerCase();
  return [
    `https://github.com/${expected}`,
    `https://github.com/${expected}.git`,
    `git@github.com:${expected}`,
    `git@github.com:${expected}.git`,
    `ssh://git@github.com/${expected}`,
    `ssh://git@github.com/${expected}.git`,
  ].includes(url.trim().toLowerCase());
}
export async function validateRepository(
  repository: string,
  p: Project,
  remote = "origin",
) {
  if (
    p.repository_url.toLowerCase() !==
    `https://github.com/${p.repository_owner}/${p.repository_name}.git`.toLowerCase()
  )
    throw new Blocked(
      "Registered network URL must be the canonical credential-free GitHub HTTPS URL",
    );
  const actual = await realpath(repository);
  await git(actual, ["rev-parse", "--git-common-dir"]);
  const remoteUrl = (
    await git(actual, ["config", "--local", "--get", `remote.${remote}.url`])
  ).trim();
  if (!matchesRepository(remoteUrl, p))
    throw new Blocked(
      "Configured remote does not match the registered GitHub repository",
    );
  const config = await git(actual, ["config", "--local", "--list"]);
  if (
    /^(url\.|include\.|includeif\.|filter\.|http\.|credential\.|core\.gitproxy)/im.test(
      config,
    )
  )
    throw new Blocked(
      "Repository has unsupported credential, URL rewrite, include, or filter configuration",
    );
  return actual;
}
export async function storage(config: LocalProject) {
  if (!isAbsolute(config.storage_root))
    throw new Blocked("storage_root must be an approved absolute path");
  await mkdir(config.storage_root, { recursive: true, mode: 0o700 });
  const root = await realpath(config.storage_root);
  const repository =
    config.mode === "existing"
      ? await realpath(config.repository_path!)
      : join(root, "projects", config.project_id);
  if (
    config.mode === "existing" &&
    (root === repository ||
      root.startsWith(repository + "/") ||
      repository.startsWith(root + "/"))
  )
    throw new Blocked(
      "Storage and existing checkout must be separate directories",
    );
  return { root, repository };
}
export async function initializeRepository(
  config: LocalProject,
  p: Project,
  token?: string,
  runGit: typeof git = git,
) {
  const { root, repository } = await storage(config);
  if (config.mode === "managed") {
    await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
    try {
      await lstat(repository);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await runGit(
        root,
        [
          "clone",
          "--bare",
          "--origin",
          config.remote,
          "--",
          p.repository_url,
          repository,
        ],
        token,
      );
    }
  }
  await validateRepository(repository, p, config.remote);
  for (const base of p.allowed_base_branches)
    if (
      !(await remoteHead(
        repository,
        p.repository_url,
        base,
        token,
        false,
        runGit,
      ))
    )
      throw new Blocked("Approved default/base branch does not exist");
  return repository;
}
export async function remoteHead(
  repo: string,
  url: string,
  branch: string,
  token?: string,
  allowLocal = false,
  runGit: typeof git = git,
) {
  branchSchema.parse(branch);
  const text = await runGit(
    repo,
    ["ls-remote", "--refs", "--", url, `refs/heads/${branch}`],
    token,
    allowLocal,
  );
  const lines = text.trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  if (
    lines.length !== 1 ||
    !lines[0].endsWith(`\trefs/heads/${branch}`) ||
    !/^[a-f0-9]{40,64}\t/.test(lines[0])
  )
    throw new Blocked("Unexpected remote ref response");
  return lines[0].split("\t")[0];
}
export async function fetchBranch(
  repo: string,
  url: string,
  branch: string,
  token?: string,
  allowLocal = false,
) {
  const sha = await remoteHead(repo, url, branch, token, allowLocal);
  if (!sha) throw new Blocked("Approved remote branch does not exist");
  await git(
    repo,
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      url,
      `refs/heads/${branch}`,
    ],
    token,
    allowLocal,
  );
  await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  return sha;
}
export async function createWorktree(
  repo: string,
  path: string,
  branch: string,
  start: string,
) {
  branchSchema.parse(branch);
  if (!branch.startsWith("conduit/job-"))
    throw new Blocked("Only Conduit feature branches may be used");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Blocked(
      "Worktree parent is a symlink; use its canonical approved path",
    );
  try {
    await lstat(path);
    if ((await realpath(path)) !== resolve(path))
      throw new Blocked("Worktree path is a symlink");
    if (
      (await git(path, ["rev-parse", "--show-toplevel"])).trim() !== path ||
      (await realpath(
        resolve(
          path,
          (await git(path, ["rev-parse", "--git-common-dir"])).trim(),
        ),
      )) !==
        (await realpath(
          resolve(
            repo,
            (await git(repo, ["rev-parse", "--git-common-dir"])).trim(),
          ),
        )) ||
      (await git(path, ["symbolic-ref", "--short", "HEAD"])).trim() !== branch
    )
      throw new Blocked("Existing worktree identity mismatch");
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let existing: string | undefined;
  try {
    existing = (
      await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])
    ).trim();
  } catch {}
  if (existing && existing !== start)
    throw new Blocked(
      "Existing feature branch differs from approved starting commit",
    );
  await git(
    repo,
    existing
      ? ["worktree", "add", "--", path, branch]
      : ["worktree", "add", "-b", branch, "--", path, start],
  );
}
export async function assertHead(
  worktree: string,
  branch: string,
  head: string,
) {
  if (
    (await git(worktree, ["symbolic-ref", "--short", "HEAD"])).trim() !==
      branch ||
    (await git(worktree, ["rev-parse", "HEAD"])).trim() !== head
  )
    throw new Blocked("Worktree branch or HEAD changed unexpectedly");
}
export async function safePush(
  repo: string,
  url: string,
  branch: string,
  head: string,
  expected: string | null,
  token?: string,
  allowLocal = false,
) {
  if (!branch.startsWith("conduit/job-"))
    throw new Blocked("Push target is outside the feature namespace");
  branchSchema.parse(branch);
  if ((await remoteHead(repo, url, branch, token, allowLocal)) !== expected)
    throw new Blocked(
      "Remote branch changed unexpectedly; no force push was attempted",
    );
  // Normal fast-forward only. The second server-side check rejects divergent concurrent pushes.
  await git(
    repo,
    [
      "push",
      "--no-verify",
      "--porcelain",
      "--",
      url,
      `${head}:refs/heads/${branch}`,
    ],
    token,
    allowLocal,
  );
}
export function worktreePath(root: string, p: Project, rootJobId: string) {
  z.string().uuid().parse(rootJobId);
  return join(root, "worktrees", p.id, rootJobId);
}
