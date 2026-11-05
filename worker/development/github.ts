import { readFile, stat } from "node:fs/promises";
export type Project = {
  id: string;
  name: string;
  repository_owner: string;
  repository_name: string;
  repository_url: string;
  default_branch: string;
  allowed_base_branches: string[];
  enabled: boolean;
};
export class Blocked extends Error {}
export type PullRequest = {
  number: number;
  url: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  head?: string;
  base_branch?: string;
};
export class GitHub {
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
    private policyToken?: string,
  ) {
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(token))
      throw Error(
        "A fine-grained GitHub token for a dedicated write-only bot is required",
      );
  }
  static async fromEnvironment() {
    const path = process.env.CONDUIT_GITHUB_TOKEN_FILE;
    if (!path)
      throw Error(
        "Set CONDUIT_GITHUB_TOKEN_FILE to a private worker-only token file",
      );
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0)
      throw Error("GitHub token file must have mode 600");
    const auditPath = process.env.CONDUIT_GITHUB_POLICY_TOKEN_FILE;
    let policyToken: string | undefined;
    if (auditPath) {
      if (((await stat(auditPath)).mode & 0o077) !== 0)
        throw Error("Policy audit token file must have mode 600");
      policyToken = (await readFile(auditPath, "utf8")).trim();
      if (!/^github_pat_[A-Za-z0-9_]+$/.test(policyToken))
        throw Error("Policy audit requires a fine-grained read-only token");
    }
    return new GitHub(
      (await readFile(path, "utf8")).trim(),
      fetch,
      policyToken,
    );
  }
  // Used only by trusted Git subprocesses via an ephemeral askpass program; never a remote URL.
  gitToken() {
    return this.token;
  }
  async request(
    project: Project,
    suffix: string,
    method = "GET",
    body?: unknown,
    policyRead = false,
  ): Promise<any> {
    if (policyRead && (method !== "GET" || !/^\/rulesets\/\d+$/.test(suffix)))
      throw Error(
        "Policy audit credentials are restricted to reading ruleset details",
      );
    const path = `/repos/${encodeURIComponent(project.repository_owner)}/${encodeURIComponent(project.repository_name)}${suffix}`;
    let response: Response;
    try {
      response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${policyRead ? this.policyToken : this.token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Error(
        "GitHub request failed or timed out; publication can be reconciled",
      );
    }
    if (!response.ok)
      throw Error(
        `GitHub request failed (${response.status}); verify repository permissions or retry publication`,
      );
    return response.json();
  }
  async safety(project: Project, base = project.default_branch) {
    const repo = await this.request(project, "");
    if (
      repo.full_name?.toLowerCase() !==
        `${project.repository_owner}/${project.repository_name}`.toLowerCase() ||
      repo.default_branch !== project.default_branch ||
      !repo.permissions?.push ||
      repo.permissions?.admin ||
      repo.permissions?.maintain ||
      repo.allow_auto_merge
    )
      throw new Blocked(
        "Repository identity, least-privilege write access, default branch or auto-merge policy is unsafe",
      );
    const rules = await this.request(
      project,
      `/rules/branches/${encodeURIComponent(base)}?per_page=100`,
    );
    // Strict supported policy: active repository ruleset restricts updates; only repository
    // admins (role ID 5) may bypass it. A push-only worker cannot merge, even after approval.
    const candidates = rules.filter(
      (r: any) => r.type === "update" && r.ruleset_source_type === "Repository",
    );
    let restricted = false;
    for (const r of candidates) {
      let rule = await this.request(project, `/rulesets/${r.ruleset_id}`);
      if (!Array.isArray(rule.bypass_actors) && this.policyToken)
        rule = await this.request(
          project,
          `/rulesets/${r.ruleset_id}`,
          "GET",
          undefined,
          true,
        );
      if (
        rule.enforcement === "active" &&
        rule.rules?.some((v: any) => v.type === "update") &&
        Array.isArray(rule.bypass_actors) &&
        rule.bypass_actors.every(
          (a: any) => a.actor_type === "RepositoryRole" && a.actor_id === 5,
        )
      )
        restricted = true;
    }
    const review = rules.some(
      (r: any) =>
        r.type === "pull_request" &&
        r.parameters?.required_approving_review_count >= 1,
    );
    if (!restricted || !review)
      throw new Blocked(
        "Base branch requires active update restriction (admin-only bypass) and at least one human PR approval",
      );
  }
  normalize(raw: any): PullRequest {
    if (
      !Number.isInteger(raw.number) ||
      !/^https:\/\/github\.com\//.test(raw.html_url) ||
      !["open", "closed"].includes(raw.state)
    )
      throw Error("Invalid GitHub PR response");
    return {
      number: raw.number,
      url: raw.html_url,
      draft: raw.draft === true,
      state: raw.state,
      merged: raw.merged === true || !!raw.merged_at,
      ...(raw.head?.sha ? { head: raw.head.sha } : {}),
      ...(raw.base?.ref ? { base_branch: raw.base.ref } : {}),
    };
  }
  async find(
    project: Project,
    branch: string,
  ): Promise<PullRequest | undefined> {
    const prs = await this.request(
      project,
      `/pulls?state=all&head=${encodeURIComponent(project.repository_owner + ":" + branch)}&per_page=100`,
    );
    if (prs.length > 1)
      throw new Blocked(
        "Multiple PRs refer to the feature branch; administrator reconciliation required",
      );
    if (prs[0] && prs[0].head?.ref !== branch)
      throw new Blocked("GitHub PR head branch identity mismatch");
    return prs[0] ? this.normalize(prs[0]) : undefined;
  }
  async read(project: Project, number: number) {
    return this.normalize(await this.request(project, `/pulls/${number}`));
  }
  async publish(
    project: Project,
    branch: string,
    base: string,
    title: string,
    body: string,
  ) {
    let pr = await this.find(project, branch);
    if (!pr) {
      try {
        pr = this.normalize(
          await this.request(project, "/pulls", "POST", {
            head: branch,
            base,
            title,
            body,
            draft: true,
            maintainer_can_modify: false,
          }),
        );
      } catch (error) {
        pr = await this.find(project, branch);
        if (!pr) throw error;
      }
    }
    if (
      pr.state !== "open" ||
      pr.merged ||
      !pr.draft ||
      (pr.base_branch && pr.base_branch !== base)
    )
      throw new Blocked(
        "PR was closed, merged, or made ready for review; human action required",
      );
    return this.normalize(
      await this.request(project, `/pulls/${pr.number}`, "PATCH", {
        title,
        body,
      }),
    );
  }
}
