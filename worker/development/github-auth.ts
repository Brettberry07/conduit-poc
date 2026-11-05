import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitHubSecurity } from "./github-policy";

const exec = promisify(execFile);
type Environment = Readonly<Record<string, string | undefined>>;

// These locations are denied to Codex/checks even when gh uses a custom config home.
export function githubCredentialPaths(env: Environment = process.env) {
  return [
    resolve(
      env.GH_CONFIG_DIR ??
        join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh"),
    ),
    join(homedir(), ".config", "gh"),
    join(homedir(), "Library", "Keychains"),
  ];
}

export async function githubCliToken(env: Environment): Promise<string> {
  try {
    // Fixed local command, no shell and no job-controlled arguments. Never inherit
    // GH_DEBUG, token overrides or arbitrary subprocess configuration.
    const { stdout } = await exec(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        cwd: homedir(),
        env: {
          NODE_ENV: "production",
          HOME: homedir(),
          PATH: env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
          ...(env.GH_CONFIG_DIR
            ? { GH_CONFIG_DIR: resolve(env.GH_CONFIG_DIR) }
            : {}),
          ...(env.XDG_CONFIG_HOME
            ? { XDG_CONFIG_HOME: resolve(env.XDG_CONFIG_HOME) }
            : {}),
        },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16384,
      },
    );
    return stdout.trim();
  } catch {
    // execFile errors include stdout/stderr: never let them reach worker logs.
    throw Error(
      "Local GitHub CLI authentication unavailable; run gh auth login --hostname github.com or configure CONDUIT_GITHUB_TOKEN_FILE",
    );
  }
}

async function privateToken(path: string, label: string) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw Error(`${label} file must be a private mode-600 file`);
  return (await readFile(path, "utf8")).trim();
}

export async function loadGitHubCredentials(
  security: GitHubSecurity,
  env: Environment = process.env,
  cliToken: typeof githubCliToken = githubCliToken,
) {
  let token: string;
  if (env.CONDUIT_GITHUB_TOKEN_FILE) {
    // An explicitly configured file always wins; errors never fall back to gh.
    token = await privateToken(env.CONDUIT_GITHUB_TOKEN_FILE, "GitHub token");
  } else if (security.policy === "prototype") {
    token = await cliToken(env);
  } else {
    throw Error(
      "Set CONDUIT_GITHUB_TOKEN_FILE to a private worker-only fine-grained token file for strict_bot mode",
    );
  }
  let policyToken: string | undefined;
  // Prototype never reads or uses an audit credential, even if a stale variable remains.
  if (
    security.policy === "strict_bot" &&
    env.CONDUIT_GITHUB_POLICY_TOKEN_FILE
  ) {
    policyToken = await privateToken(
      env.CONDUIT_GITHUB_POLICY_TOKEN_FILE,
      "Policy audit token",
    );
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(policyToken))
      throw Error("Policy audit requires a fine-grained read-only token");
  }
  return { token, policyToken };
}
