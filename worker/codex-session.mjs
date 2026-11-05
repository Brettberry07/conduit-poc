// Trusted SDK supervisor. No worker/API/database credentials are inherited.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
const abort = new AbortController();
const send = (event) => {
  if (process.connected) process.send(event, () => {});
};
process.on("disconnect", () => {
  void rm(join(process.env.CODEX_HOME, "auth.json"), { force: true });
  abort.abort();
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, 1000).unref();
});
process.on("SIGTERM", () => abort.abort());
process.once("message", async ({ workspace, instructions, timeout }) => {
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const codex = new Codex({
      env: { ...process.env },
      config: {
        default_permissions: "conduit",
        allow_login_shell: false,
        tool_output_token_limit: 2000,
        shell_environment_policy: {
          inherit: "none",
          set: {
            OPENSSL_CONF: "/dev/null",
            PATH: process.env.PATH,
            HOME: workspace,
            TMPDIR: process.env.TMPDIR || workspace + "/.tmp",
          },
        },
        features: {
          multi_agent: false,
          plugins: false,
          remote_plugin: false,
          apps: false,
          in_app_browser: false,
        },
        apps: { _default: { enabled: false } },
      },
    });
    const thread = codex.startThread({
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      webSearchMode: "disabled",
      model: process.env.CONDUIT_CODEX_MODEL || undefined,
    });
    const { events } = await thread.runStreamed(instructions, {
      signal: abort.signal,
    });
    for await (const event of events) {
      // Deliberately omit raw command output, prompts, and reasoning from logs.
      const item = "item" in event ? event.item : undefined;
      send({
        type: event.type,
        item_type: item?.type,
        thread_id:
          event.type === "thread.started" ? event.thread_id : undefined,
        summary:
          item?.type === "agent_message" ? item.text.slice(0, 2000) : undefined,
        error:
          event.type === "turn.failed"
            ? event.error.message.slice(0, 1000)
            : event.type === "error"
              ? event.message.slice(0, 1000)
              : undefined,
      });
    }
  } catch {
    send({
      type: "error",
      error: abort.signal.aborted
        ? "Codex execution interrupted or timed out"
        : "Codex SDK execution failed; check local login and sandbox support",
    });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await rm(join(process.env.CODEX_HOME, "auth.json"), { force: true });
    if (process.connected) process.disconnect();
  }
});
