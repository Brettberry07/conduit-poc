import { mkdtemp, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, permitted, obviousSecret, type LocalProject } from "./git";
import { Blocked } from "./github";
export type ChangedFile = {
  path: string;
  old_path?: string;
  status:
    "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";
  additions: number;
  deletions: number;
  binary?: boolean;
  diff_truncated?: boolean;
};
export type Changes = {
  files: ChangedFile[];
  diff: string;
  tree: string;
  summary: string;
};
export async function captureChanges(
  worktree: string,
  start: string,
  policy: LocalProject["policy"],
  end?: string,
): Promise<Changes> {
  const temporary = await mkdtemp(join(tmpdir(), "conduit-index-"));
  const env = { GIT_INDEX_FILE: join(temporary, "index") };
  try {
    let tree = end;
    if (!tree) {
      const status = (
        await git(worktree, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
      ).split("\0");
      const paths = new Set<string>();
      for (let i = 0; i < status.length; i++) {
        if (!status[i]) continue;
        const entry = status[i],
          path = entry.slice(3);
        paths.add(path);
        if (/[RC]/.test(entry.slice(0, 2))) paths.add(status[++i]);
      }
      if (paths.size > 100)
        throw new Blocked(
          "Changed-file limit exceeded (100); changes preserved",
        );
      for (const path of paths) {
        if (!permitted(path, policy))
          throw new Blocked(
            "A changed file violates the administrator workspace policy; contents withheld",
          );
        const info = await lstat(join(worktree, path)).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        );
        if (
          info &&
          (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
        )
          throw new Blocked(
            "Changed file is a symlink, binary candidate, or oversized; contents withheld",
          );
      }
      await git(worktree, ["read-tree", start], undefined, false, env);
      if (paths.size)
        await git(
          worktree,
          ["--literal-pathspecs", "add", "-A", "--", ...paths],
          undefined,
          false,
          env,
        );
      tree = (
        await git(worktree, ["write-tree"], undefined, false, env)
      ).trim();
    }
    const names = (
      await git(worktree, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        start,
        tree,
        "--",
      ])
    ).split("\0");
    const files: ChangedFile[] = [];
    let diff = "";
    for (let i = 0; i < names.length && names[i];) {
      const code = names[i++];
      let path = names[i++],
        old_path: string | undefined;
      if (/[RC]/.test(code[0])) {
        old_path = path;
        path = names[i++];
      }
      if (
        !permitted(path, policy) ||
        (old_path && !permitted(old_path, policy))
      )
        throw new Blocked("Change violates workspace policy; diff withheld");
      if (files.length >= 100) throw new Blocked("Change limit exceeded");
      // Scan both old and new blobs, including deleted files. Never return secret-bearing diffs.
      for (const [ref, name] of [
        [start, old_path ?? path],
        [tree, path],
      ]) {
        const spec = await git(worktree, [
          "--literal-pathspecs",
          "ls-tree",
          ref,
          "--",
          name,
        ]);
        if (!spec) continue;
        if (!spec.startsWith("100644 ") && !spec.startsWith("100755 "))
          throw new Blocked("Symlink/submodule changes are prohibited");
        const object = spec.split(/\s+/)[2];
        const size = Number(
          (await git(worktree, ["cat-file", "-s", object])).trim(),
        );
        if (size > 256 * 1024)
          throw new Blocked("Changed blob exceeds size limit; diff withheld");
        const content = await git(worktree, ["cat-file", "blob", object]);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(content))
          throw new Blocked("Binary changes require manual handling");
        if (obviousSecret(content))
          throw new Blocked(
            "Potential secret in changed content; diff and publication withheld",
          );
      }
      const paths = old_path ? [old_path, path] : [path];
      const stats = (
        await git(worktree, [
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          start,
          tree,
          "--",
          ...paths,
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((s) => s.split("\t"));
      if (stats.some((s) => s[0] === "-" || s[1] === "-"))
        throw new Blocked("Binary changes require manual handling");
      let patch = await git(worktree, [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        start,
        tree,
        "--",
        ...paths,
      ]);
      if (obviousSecret(patch))
        throw new Blocked("Potential secret in diff; publication withheld");
      const room = Math.max(0, 128000 - Buffer.byteLength(diff)),
        cap = Math.min(16000, room),
        truncated = Buffer.byteLength(patch) > cap;
      patch = Buffer.from(patch).subarray(0, cap).toString("utf8");
      while (Buffer.byteLength(patch) > cap) patch = patch.slice(0, -1);
      diff += patch;
      files.push({
        path,
        ...(old_path ? { old_path } : {}),
        status:
          (
            {
              A: "added",
              M: "modified",
              D: "deleted",
              R: "renamed",
              C: "copied",
              T: "type_changed",
            } as const
          )[code[0] as "A"] ?? "modified",
        additions: stats.reduce((n, s) => n + (Number(s[0]) || 0), 0),
        deletions: stats.reduce((n, s) => n + (Number(s[1]) || 0), 0),
        ...(truncated ? { diff_truncated: true } : {}),
      });
    }
    const count = (status: ChangedFile["status"]) =>
      files.filter((f) => f.status === status).length;
    return {
      files,
      diff,
      tree,
      summary: `${files.length} files changed: ${count("added")} added, ${count("modified")} modified, ${count("deleted")} deleted, ${count("renamed")} renamed`,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function commitChanges(
  worktree: string,
  branch: string,
  start: string,
  changes: Changes,
  message: string,
) {
  if ((await git(worktree, ["rev-parse", "HEAD"])).trim() !== start)
    throw new Blocked("Starting HEAD changed before commit");
  const fresh = await captureChanges(worktree, start, {
    allowed_paths: ["*"],
    read_only_paths: [],
  });
  if (fresh.tree !== changes.tree)
    throw new Blocked("Files changed after verification; publication blocked");
  // Commit the inspected tree, not the user's index. Update only this linked worktree's branch.
  const head = (
    await git(worktree, [
      "-c",
      "user.name=Conduit",
      "-c",
      "user.email=conduit@users.noreply.github.com",
      "commit-tree",
      changes.tree,
      "-p",
      start,
      "-m",
      message,
    ])
  ).trim();
  await git(worktree, ["update-ref", `refs/heads/${branch}`, head, start]);
  // Synchronize only the worktree index, never the original checkout.
  await git(worktree, ["read-tree", head]);
  return head;
}
