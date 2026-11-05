import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCodex, redact, snapshot, timeoutMs } from "../worker/codex";
test("Codex rejects arbitrary projects before workspace creation or login access", async () => {
  let renewed = false;
  const outcome = await executeCodex(
    {
      id: "test",
      claim_token: "test",
      task: "codex_task",
      instructions: "hello",
      project: "/Users/some-project",
    },
    async () => {
      renewed = true;
    },
    () => false,
  );
  assert.equal(outcome.action, "failed");
  assert.equal(renewed, false);
  assert.equal(outcome.result.verification.status, "not_run");
  assert.equal(outcome.result.workspace, undefined);
});
test("timeout configuration and output redaction are bounded", () => {
  const old = process.env.CODEX_TIMEOUT_MS;
  try {
    for (const v of ["0", "NaN", "999", "600001"]) {
      process.env.CODEX_TIMEOUT_MS = v;
      assert.throws(timeoutMs);
    }
    process.env.CODEX_TIMEOUT_MS = "1000";
    assert.equal(timeoutMs(), 1000);
    const secret = "cnd_live_" + "a".repeat(43);
    assert.ok(!redact(secret).includes(secret));
    assert.equal(redact("x".repeat(10000)).length, 2000);
  } finally {
    if (old === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = old;
  }
});
test("changed-file snapshots detect source edits and refuse symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conduit-snapshot-"));
  try {
    await writeFile(join(dir, "index.ts"), "export const n=1;");
    const before = await snapshot(dir);
    await writeFile(join(dir, "index.ts"), "export const n=2;");
    const after = await snapshot(dir);
    assert.notEqual(before["index.ts"], after["index.ts"]);
    await symlink("/etc/hosts", join(dir, "outside"));
    await assert.rejects(snapshot(dir), /symlinks/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
