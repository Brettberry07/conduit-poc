import { branchSchema } from "../../src/lib/development";
import {
  githubSecuritySchema,
  loadGitHubSecurity,
  PROTOTYPE_WARNING,
  type GitHubSecurity,
} from "./github-policy";
import { loadGitHubCredentials } from "./github-auth";
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
class GitHubRequestError extends Error {
  constructor(public httpStatus: number) {
    super(
      `GitHub request failed (${httpStatus}); verify repository permissions or retry publication`,
    );
  }
}
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
    private security: GitHubSecurity = { policy: "strict_bot" },
  ) {
    this.security = githubSecuritySchema.parse(security);
    const supported =
      this.security.policy === "strict_bot"
        ? /^github_pat_[A-Za-z0-9_]+$/
        : /^(?:github_pat_|gh[po]_)[A-Za-z0-9_]+$/;
    if (!supported.test(token))
      throw Error(
        this.security.policy === "strict_bot"
          ? "A fine-grained GitHub personal access token is required in strict_bot mode"
          : "Prototype requires a GitHub CLI OAuth token, classic PAT or fine-grained PAT",
      );
  }
  static async fromEnvironment() {
    const security = await loadGitHubSecurity();
    const { token, policyToken } = await loadGitHubCredentials(security);
    return new GitHub(token, fetch, policyToken, security);
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
    if (
      this.security.policy === "prototype" &&
      !this.security.approved_repositories.some(
        (r) =>
          r.toLowerCase() ===
          `${project.repository_owner}/${project.repository_name}`.toLowerCase(),
      )
    )
      throw new Blocked("Repository is not in the local prototype allowlist");
    if (policyRead && (method !== "GET" || !/^\/rulesets\/\d+$/.test(suffix)))
      throw Error(
        "Policy audit credentials are restricted to reading ruleset details",
      );
    const path = `/repos/${encodeURIComponent(project.repository_owner)}/${encodeURIComponent(project.repository_name)}${suffix}`;
    return this.send(
      path,
      method,
      body,
      policyRead ? this.policyToken! : this.token,
    );
  }
  private async send(
    path: string,
    method: string,
    body: unknown,
    token: string,
  ): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Error(
        "GitHub request failed or timed out; publication can be reconciled",
      );
    }
    if (!response.ok) throw new GitHubRequestError(response.status);
    return response.json();
  }
  async safety(project: Project, base = project.default_branch) {
    const name = `${project.repository_owner}/${project.repository_name}`;
    if (
      !project.enabled ||
      !branchSchema.safeParse(base).success ||
      !project.allowed_base_branches.includes(base)
    )
      throw new Blocked("Project or configured base branch is not approved");
    if (
      this.security.policy === "prototype" &&
      !this.security.approved_repositories.some(
        (r) => r.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Blocked("Repository is not in the local prototype allowlist");
    const repo = await this.request(project, "");
    if (
      repo.full_name?.toLowerCase() !== name.toLowerCase() ||
      project.repository_url.toLowerCase() !==
        `https://github.com/${name}.git`.toLowerCase() ||
      repo.default_branch !== project.default_branch ||
      repo.permissions?.push !== true ||
      repo.permissions?.pull === false ||
      repo.archived === true ||
      (this.security.policy === "strict_bot" && repo.allow_auto_merge !== false)
    )
      throw new Blocked(
        "Repository identity, write access, archive state, default branch or auto-merge policy is unsafe",
      );
    if (
      this.security.policy === "strict_bot" &&
      (repo.permissions?.admin || repo.permissions?.maintain)
    )
      throw new Blocked(
        "strict_bot rejects owner, admin and maintain identities",
      );
    if (this.security.policy === "prototype") {
      if (repo.archived !== false || repo.permissions?.pull !== true)
        throw new Blocked(
          "Repository archive state and read/write permissions must be verifiable",
        );
      const branch = await this.request(
        project,
        `/branches/${encodeURIComponent(base)}`,
      );
      if (branch.name !== base)
        throw new Blocked("Configured base branch is missing or mismatched");
      return { policy: this.security.policy, warnings: [PROTOTYPE_WARNING] };
    }
    const rules = await this.request(
      project,
      `/rules/branches/${encodeURIComponent(base)}?per_page=100`,
    );
    if (!Array.isArray(rules) || rules.length >= 100)
      throw new Blocked("Active branch rules could not be completely verified");
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
    return { policy: this.security.policy, warnings: [] as string[] };
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
    if (
      !branchSchema.safeParse(branch).success ||
      !branch.startsWith("conduit/job-") ||
      branch === project.default_branch ||
      project.allowed_base_branches.includes(branch)
    )
      throw new Blocked(
        "Publication must use an independent Conduit feature branch",
      );
    if (!project.allowed_base_branches.includes(base))
      throw new Blocked("Pull request base is not approved");
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
