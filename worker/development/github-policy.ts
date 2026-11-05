import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

// Administrator-local configuration only. Never derive this policy from cloud jobs.
export const githubSecuritySchema = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("strict_bot") }).strict(),
  z
    .object({
      policy: z.literal("prototype"),
      acknowledge_prototype_risk: z.literal(true),
      approved_repositories: z
        .array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/))
        .min(1)
        .max(100),
    })
    .strict(),
]);
export type GitHubSecurity = z.infer<typeof githubSecuritySchema>;
export const PROTOTYPE_WARNING =
  "prototype (development only): the credential may retain merge or administrative capabilities. Repository rules and approvals are not audited; human review is required before merging.";

export async function loadGitHubSecurity(
  path = process.env.CONDUIT_GITHUB_SECURITY_FILE,
): Promise<GitHubSecurity> {
  if (!path) return { policy: "strict_bot" };
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw Error(
      "GitHub security configuration must be a private mode-600 file",
    );
  try {
    return githubSecuritySchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw Error(
      "Invalid local GitHub security policy; no fallback is permitted",
    );
  }
}
