import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimedJob } from "./runner";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules/.bin/codex");
export const redact = (s: string) =>
  s
    .replace(/cnd_live_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(?:sk-|eyJ)[A-Za-z0-9_.-]{15,}/g, "[REDACTED]")
    .slice(0, 2000);
export function timeoutMs() {
  const value = Number(process.env.CODEX_TIMEOUT_MS ?? 180000);
  if (!Number.isInteger(value) || value < 1000 || value > 600000)
    throw Error("CODEX_TIMEOUT_MS must be 1000..600000");
  return value;
}
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let entries = 0,
    bytes = 0;
  async function walk(prefix: string, depth: number) {
    if (depth > 10) throw Error("Workspace depth limit exceeded");
    for (const entry of await readdir(join(dir, prefix), {
      withFileTypes: true,
    })) {
      if (["node_modules", ".tmp", ".git"].includes(entry.name)) continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (++entries > 500 || name.length > 240)
        throw Error("Workspace file limit exceeded");
      const stat = await lstat(join(dir, name));
      if (stat.isSymbolicLink())
        throw Error("Workspace symlinks are forbidden");
      if (stat.isDirectory()) await walk(name, depth + 1);
      else {
        bytes += stat.size;
        if (
          !stat.isFile() ||
          stat.size > 1024 * 1024 ||
          bytes > 8 * 1024 * 1024
        )
          throw Error("Workspace size limit exceeded");
        files[name] = createHash("sha256")
          .update(await readFile(join(dir, name)))
          .digest("hex");
      }
    }
  }
  await walk("", 0);
  return files;
}
function killGroup(pid: number | undefined) {
  if (pid)
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
}
export async function cleanupAttemptAuth(attempt: string) {
  const actual = await realpath(attempt).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (!actual) return;
  if (
    dirname(actual) !== (await realpath(tmpdir())) ||
    !/^conduit-codex-[A-Za-z0-9]+$/.test(basename(actual))
  )
    throw Error("Invalid recovery workspace path");
  await rm(join(actual, "auth"), { recursive: true, force: true });
}
export async function executeCodex(
  job: ClaimedJob,
  renew: () => Promise<void>,
  stopping: () => boolean,
  rememberAttempt: (attempt: string) => Promise<void> = async () => {},
) {
  const attemptId = randomUUID();
  const started = new Date().toISOString();
  const result: Record<string, any> = {
    simulated: false,
    attempt_id: attemptId,
    worker_id: job.worker_id,
    attempt_count: job.attempt_count,
    project: job.project,
    started_at: started,
    execution: { status: "failed" },
    verification: { status: "not_run", checks: [] },
    changed_files: [],
    events: [],
  };
  let attempt: string | undefined;
  let transportFailure = false;
  const keepLease = async () => {
    try {
      await renew();
    } catch (e) {
      transportFailure = true;
      throw e;
    }
  };
  try {
    if (job.project !== "typescript-sandbox" || !job.instructions?.trim())
      throw Error("Invalid Codex task or project");
    const timeout = timeoutMs();
    if (Number(process.versions.node.split(".")[0]) !== 24)
      throw Error(
        "Codex worker requires Node 24 (official standalone distribution recommended)",
      );
    await keepLease();
    // Always outside Conduit and real projects. No caller-supplied paths.
    attempt = await mkdtemp(join(tmpdir(), "conduit-codex-"));
    await rememberAttempt(attempt);
    const workspace = join(attempt, "project");
    const authHome = join(attempt, "auth");
    const userHome = join(attempt, "home");
    await cp(join(root, "sandbox/typescript"), workspace, { recursive: true });
    await mkdir(authHome, { mode: 0o700 });
    await mkdir(userHome, { mode: 0o700 });
    await mkdir(join(workspace, ".tmp"));
    // Use only official file-backed local Codex login; never copy config, plugins, MCP or secrets.
    const loginHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    await writeFile(
      join(authHome, "auth.json"),
      await readFile(join(loginHome, "auth.json")),
      { mode: 0o600 },
    );
    await cp(
      join(root, "node_modules/typescript"),
      join(workspace, "node_modules/typescript"),
      { recursive: true },
    );
    await cp(
      join(root, "node_modules/@typescript"),
      join(workspace, "node_modules/@typescript"),
      { recursive: true },
    );
    const node = await realpath(process.execPath);
    const runtime = `${JSON.stringify(dirname(node))} = "read"`;
    const config = `default_permissions = "conduit"\napproval_policy = "never"\nallow_login_shell = false\nweb_search = "disabled"\n[permissions.conduit.filesystem]\n":minimal" = "read"\n"/tmp" = "deny"\n"/private/tmp" = "deny"\n"/var/folders" = "deny"\n"/private/var/folders" = "deny"\n${JSON.stringify(attempt)} = "deny"\n${JSON.stringify(loginHome)} = "deny"\n${runtime}\n${JSON.stringify(workspace)} = "write"\n${JSON.stringify(join(workspace, "node_modules"))} = "read"\n${JSON.stringify(join(workspace, ".codex"))} = "deny"\n${JSON.stringify(join(workspace, "package.json"))} = "read"\n${JSON.stringify(join(workspace, "tsconfig.json"))} = "read"\n[permissions.conduit.network]\nenabled = false\n`;
    await writeFile(join(authHome, "config.toml"), config, { mode: 0o600 });
    const env = {
      NODE_ENV: "production" as const,
      OPENSSL_CONF: "/dev/null",
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      HOME: userHome,
      CODEX_HOME: authHome,
      TMPDIR: join(workspace, ".tmp"),
      ...(process.env.CONDUIT_CODEX_MODEL
        ? { CONDUIT_CODEX_MODEL: process.env.CONDUIT_CODEX_MODEL }
        : {}),
    };
    const safety = await sandboxCommand(
      "sandbox_preflight",
      [
        node,
        "-e",
        `const fs=require('node:fs'); for(const p of process.argv.slice(1)) { let readable=false; try {fs.readFileSync(p); readable=true;} catch {} if(readable) { console.log("Boundary unexpectedly readable: " + process.argv.slice(1).indexOf(p)); process.exit(12); } } console.log('Runtime works; Conduit and Codex credentials are unreadable');`,
        join(root, "package.json"),
        join(authHome, "auth.json"),
        join(loginHome, "auth.json"),
      ],
      workspace,
      env,
      new AbortController().signal,
      5000,
    );
    result.sandbox_preflight = safety;
    if (safety.exit_code !== 0)
      throw Error(
        "Sandbox preflight failed: use official standalone Node 24; restrictions remain enforced",
      );
    const before = await snapshot(workspace);
    result.workspace = workspace;
    const controller = new AbortController();
    let renewalError: unknown;
    let renewing = false;
    const tick = setInterval(async () => {
      if (stopping()) controller.abort();
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      try {
        await keepLease();
      } catch (e) {
        renewalError = e;
        controller.abort();
      } finally {
        renewing = false;
      }
    }, 3000);
    try {
      const child = spawn(node, [join(root, "worker/codex-session.mjs")], {
        cwd: workspace,
        env,
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let completed = false,
        error = "";
      child.on("message", (event: any) => {
        if (result.events.length < 80)
          result.events.push({ type: event.type, item_type: event.item_type });
        if (event.thread_id) result.thread_id = event.thread_id;
        if (event.summary) result.summary = redact(event.summary);
        if (event.error) error = redact(event.error);
        if (event.type === "turn.completed") completed = true;
      });
      const timer = setTimeout(() => {
        error = "Codex execution timed out";
        killGroup(child.pid);
      }, timeout);
      const abort = () => {
        error = "Execution interrupted: shutdown or lease renewal failure";
        killGroup(child.pid);
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
        child.send(
          {
            workspace,
            instructions: `${job.title}\n${job.instructions}\nAcceptance criteria: ${job.acceptance_criteria ?? "Follow the instructions."}`,
            timeout,
          },
          (error) => {
            if (error) reject(error);
          },
        );
      }).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        killGroup(child.pid);
      });
      if (renewalError) {
        transportFailure = true;
        throw renewalError;
      }
      result.execution = {
        status: code === 0 && completed && !error ? "completed" : "failed",
        error:
          error ||
          (code !== 0
            ? "Codex process failed"
            : completed
              ? undefined
              : "Codex did not complete a turn"),
        completed_at: new Date().toISOString(),
      };
      if (!controller.signal.aborted) {
        const checks = [];
        // Do not execute npm scripts or commands provided by a client or modified by Codex.
        for (const [name, args] of [
          [
            "typescript",
            [
              node,
              join(workspace, "node_modules/typescript/bin/tsc"),
              "--noEmit",
              "--project",
              join(workspace, "tsconfig.json"),
            ],
          ],
          [
            "unit_tests",
            [node, "--test", "--test-timeout=20000", "test/*.test.mjs"],
          ],
        ] as const) {
          await keepLease();
          checks.push(
            await sandboxCommand(
              name,
              [...args],
              workspace,
              env,
              controller.signal,
            ),
          );
        }
        result.verification = {
          status: checks.every((c) => c.exit_code === 0) ? "passed" : "failed",
          checks,
        };
      }
      if (renewalError) throw renewalError;
      const after = await snapshot(workspace);
      const changed = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].filter((p) => before[p] !== after[p]);
      result.changed_files = changed.slice(0, 50);
      result.changed_files_truncated = changed.length > 50;
    } finally {
      clearInterval(tick);
    }
  } catch (e) {
    // Ownership and transport errors must return to the journal/lease recovery path.
    if (transportFailure || (e as any)?.status) throw e;
    result.execution = {
      status: "failed",
      error: redact((e as Error).message),
    };
  } finally {
    if (attempt)
      await rm(join(attempt, "auth"), { recursive: true, force: true });
  }
  result.completed_at = new Date().toISOString();
  result.execution.started_at = started;
  result.execution.completed_at ??= result.completed_at;
  result.summary ??=
    result.execution.error ||
    "Codex execution finished; see verification results";
  const ok =
    result.execution.status === "completed" &&
    result.verification.status === "passed";
  return {
    action: ok ? ("completed" as const) : ("failed" as const),
    progress: 100,
    result,
    ...(!ok
      ? {
          error: result.execution.error || "Verification failed or did not run",
        }
      : {}),
  };
}
export async function sandboxCommand(
  name: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  durationMs = 30000,
) {
  return new Promise<{
    name: string;
    exit_code: number | null;
    output: string;
    timed_out: boolean;
  }>((done) => {
    let output = "",
      timedOut = false;
    const child = spawn(
      cli,
      ["sandbox", "-P", "conduit", "-C", cwd, "--", ...args],
      { cwd, env, detached: true },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, durationMs);
    const abort = () => killGroup(child.pid);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(0, 2000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () =>
      collect(Buffer.from("Sandbox command could not start")),
    );
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      killGroup(child.pid);
      done({
        name,
        exit_code: timedOut || signal.aborted ? -1 : code,
        output: redact(output),
        timed_out: timedOut,
      });
    });
  });
}
