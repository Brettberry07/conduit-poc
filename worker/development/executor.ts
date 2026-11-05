import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxCommand, timeoutMs } from "../codex";
import { type LocalProject, git, prohibited } from "./git";
import type { ClaimedJob } from "../runner";
import { githubCredentialPaths } from "./github-auth";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export type Check = {
  name: string;
  exit_code: number | null;
  timed_out: boolean;
};
export type Execution = { thread_id?: string; checks: Check[] };
export async function executeWorktree(
  workspace: string,
  repository: string,
  config: LocalProject,
  job: ClaimedJob,
  renew: () => Promise<void>,
  stopping: () => boolean,
  phase: (value: "running" | "verifying") => Promise<void>,
  remember: (dir: string) => Promise<void>,
): Promise<Execution> {
  if (process.platform !== "darwin")
    throw Error(
      "Phase 4 Codex execution requires the tested macOS Codex sandbox",
    );
  if (process.versions.node.split(".")[0] !== "24")
    throw Error("Use official standalone Node 24 for the Codex sandbox");
  const temporary = await mkdtemp(join(tmpdir(), "conduit-codex-"));
  await remember(temporary);
  const auth = join(temporary, "auth"),
    home = join(temporary, "home"),
    scratch = join(temporary, "scratch");
  const login = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const node = await realpath(process.execPath),
    gitDir = (await git(workspace, ["rev-parse", "--absolute-git-dir"])).trim();
  const common = await realpath(
    resolve(
      workspace,
      (await git(workspace, ["rev-parse", "--git-common-dir"])).trim(),
    ),
  );
  const controller = new AbortController();
  let leaseError: unknown,
    renewing = false;
  const kill = (pid?: number) => {
    if (pid)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
  };
  const result: Execution = { checks: [] };
  let tick: ReturnType<typeof setInterval> | undefined;
  try {
    for (const dir of [auth, home, scratch]) await mkdir(dir, { mode: 0o700 });
    await writeFile(
      join(auth, "auth.json"),
      await readFile(join(login, "auth.json")),
      { mode: 0o600 },
    );
    if (config.dependency_directory) {
      const dependencies = await realpath(config.dependency_directory);
      const destination = join(workspace, "node_modules");
      const entry = await lstat(destination).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return undefined;
          throw e;
        },
      );
      if (!entry) await symlink(dependencies, destination);
      else if ((await realpath(destination)) !== dependencies)
        throw Error(
          "Dependency directory differs from approved local configuration",
        );
    }
    const grants = new Map<string, string>([
      [config.storage_root, "deny"],
      [temporary, "deny"],
      [login, "deny"],
      [root, "deny"],
      [repository, "deny"],
      [dirname(node), "read"],
      [workspace, "write"],
      [scratch, "write"],
      [join(workspace, ".git"), "deny"],
      [common, "deny"],
      [gitDir, "deny"],
      [join(workspace, ".codex"), "deny"],
    ]);
    if (config.dependency_directory) {
      grants.set(await realpath(config.dependency_directory), "read");
      grants.set(join(workspace, "node_modules"), "read");
    }
    for (const file of [
      process.env.CONDUIT_GITHUB_TOKEN_FILE,
      process.env.CONDUIT_GITHUB_POLICY_TOKEN_FILE,
      process.env.CONDUIT_GITHUB_SECURITY_FILE,
      process.env.WORKER_KEY_FILE,
      process.env.CONDUIT_PROJECTS_FILE,
    ])
      if (file)
        grants.set(await realpath(file).catch(() => resolve(file)), "deny");
    const tracked = (await git(workspace, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const file of tracked)
      if (prohibited(file)) grants.set(join(workspace, file), "deny");
    for (const p of config.policy.read_only_paths)
      grants.set(join(workspace, p), "read");
    for (const p of [
      ".env",
      ".env.local",
      ".env.production",
      ".secrets",
      ".ssh",
    ])
      grants.set(join(workspace, p), "deny");
    for (const path of githubCredentialPaths())
      grants.set(await realpath(path).catch(() => path), "deny");
    const content = `default_permissions = "conduit"\napproval_policy = "never"\nallow_login_shell = false\nweb_search = "disabled"\n[permissions.conduit.filesystem]\n":minimal" = "read"\n"/tmp" = "deny"\n"/private/tmp" = "deny"\n"/var/folders" = "deny"\n"/private/var/folders" = "deny"\n${[...grants].map(([p, v]) => `${JSON.stringify(p)} = ${JSON.stringify(v)}`).join("\n")}\n[permissions.conduit.network]\nenabled = false\n`;
    await writeFile(join(auth, "config.toml"), content, { mode: 0o600 });
    const env = {
      NODE_ENV: "production" as const,
      OPENSSL_CONF: "/dev/null",
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: auth,
      TMPDIR: scratch,
      ...(process.env.CONDUIT_CODEX_MODEL
        ? { CONDUIT_CODEX_MODEL: process.env.CONDUIT_CODEX_MODEL }
        : {}),
    };
    const preflight = await sandboxCommand(
      "sandbox_preflight",
      [
        node,
        "-e",
        `const fs=require('node:fs');for(const p of process.argv.slice(1)){try{fs.readFileSync(p);process.exit(12)}catch{}}`,
        join(root, "package.json"),
        join(auth, "auth.json"),
        join(login, "auth.json"),
        join(workspace, ".git"),
        ...githubCredentialPaths().map((path) => join(path, "hosts.yml")),
      ],
      workspace,
      env,
      controller.signal,
      5000,
    );
    if (preflight.exit_code !== 0)
      throw Error("Sandbox preflight failed; execution refused");
    tick = setInterval(async () => {
      if (stopping()) controller.abort();
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      try {
        await renew();
      } catch (e) {
        leaseError = e;
        controller.abort();
      } finally {
        renewing = false;
      }
    }, 3000);
    await renew();
    await phase("running");
    const child = spawn(node, [join(root, "worker/codex-session.mjs")], {
      cwd: workspace,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let completed = false,
      failed = false;
    child.on("message", (event: any) => {
      if (event.thread_id) result.thread_id = event.thread_id;
      if (event.type === "turn.completed") completed = true;
      if (event.error) failed = true;
    });
    const abort = () => kill(child.pid);
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failed = true;
      kill(child.pid);
    }, timeoutMs());
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", () =>
        reject(Error("Codex supervisor could not start")),
      );
      child.once("exit", done);
      child.send({
        workspace,
        timeout: timeoutMs(),
        instructions: `${job.title}\n${job.instructions}\nAcceptance criteria: ${job.acceptance_criteria ?? ""}\nWork only on source files in this worktree. Git is managed by Conduit; do not commit, push, merge, change Git metadata, or access credentials. Verification will run separately. Previous branch contents are authoritative.`,
      });
    }).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      kill(child.pid);
    });
    if (leaseError) throw leaseError;
    if (code !== 0 || !completed || failed || controller.signal.aborted)
      throw Error(
        "Codex execution failed, timed out or was interrupted; changes preserved",
      );
    await phase("verifying");
    for (const check of config.verification) {
      await renew();
      if (stopping() || controller.signal.aborted)
        throw Error("Verification interrupted");
      const r = await sandboxCommand(
        check.name,
        check.argv,
        workspace,
        env,
        controller.signal,
        check.timeout_ms,
      );
      result.checks.push({
        name: r.name,
        exit_code: r.exit_code,
        timed_out: r.timed_out,
      });
    }
    if (leaseError) throw leaseError;
    return result;
  } finally {
    if (tick) clearInterval(tick);
    await rm(auth, { recursive: true, force: true });
  }
}
