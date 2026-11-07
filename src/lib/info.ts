import { SCOPES, credentialScopes, requiredScope } from "./keys";
import { publicPage } from "./public-page";

// All inputs are explicit; describing the service needs no database or environment.
export function info(request: Request): Response {
  const descriptor = {
    service: "Conduit POC",
    architecture: {
      api: "Authenticated HTTP job API hosted on Vercel using Next.js",
      queue: "Supabase PostgreSQL persistent job queue",
      worker:
        "Local outbound worker executing up to CONDUIT_MAX_AGENTS jobs concurrently (default 4, integers 1–4), one job per agent. The server enforces at most 4 running jobs with live leases per owner (submitter_id), across worker processes and identities. The server bounds leased jobs; each worker's agent limit controls physical execution concurrency. Expired leases do not count, and abandoned local processes remain governed by lease fencing and recovery.",
    },
    task_types: [
      "simulate-development",
      "simulate-failure",
      "codex_task",
      "development",
    ],
    authentication: {
      scheme: "Bearer",
      description:
        "Persistent API keys with scoped permissions. No single credential can use every endpoint. GET /auth-check requires a Bearer key.",
      scopes: [...SCOPES],
      credential_scopes: credentialScopes,
    },
    capabilities: [
      "Idempotent job creation via Idempotency-Key",
      "Job status and result retrieval",
      "Same-job retry for eligible failed or blocked jobs",
      "Worker availability reporting",
      "Durable owner-scoped event feed, job and initiative activity history, and consumer checkpoints",
    ],
    development: [
      "Registered GitHub projects",
      "Isolated worktrees",
      "Real Codex execution",
      "Verification checks",
      "Draft pull requests",
      "Same-PR revisions",
      "Persistent single-project initiatives, versioned draft plans, atomic activation, progress, PM assessments and resume",
      "Dependencies become done only when every prerequisite pull request is merged",
      "Changes, diff, and publication retrieval",
      "Versioned agent manifest and PM playbook; normal and research-backed detailed preparation",
    ],
    descriptor_status:
      "This descriptor is static, built from the code, and does not prove current worker availability. Use GET /api/workers for live worker readiness.",
    limitations: [
      "The worker sandbox has no network access.",
      "The repository full test suite cannot run inside the sandbox.",
      "Configured verification is a bounded subset of the full suite.",
    ],
    endpoints: [
      "GET /",
      "GET /info",
      "GET /health",
      "GET /auth-check",
      "GET /api/jobs",
      "GET /api/agent/manifest",
      "GET /api/agent/events",
      "GET /api/agent/event-consumers/{name}",
      "POST /api/agent/event-consumers/{name}/ack",
      "POST /api/jobs",
      "GET /api/jobs/{id}",
      "POST /api/jobs/{id}/retry",
      "GET /api/workers",
      "POST /api/claim",
      "POST /api/heartbeat",
      "POST /api/jobs/{id}/report",
      "GET /api/projects",
      "GET /api/projects/{id}",
      "GET /api/jobs/{id}/revisions",
      "POST /api/jobs/{id}/revisions",
      "GET /api/jobs/{id}/executions",
      "GET /api/jobs/{id}/changes",
      "GET /api/jobs/{id}/diff",
      "GET /api/jobs/{id}/publication",
      "POST /api/jobs/{id}/publication",
      "POST /api/jobs/{id}/artifacts",
      "POST /api/development/pending",
      "POST /api/development/reconcile",
      "GET /api/initiatives",
      "POST /api/initiatives",
      "GET /api/initiatives/{id}",
      "PATCH /api/initiatives/{id}",
      "GET /api/initiatives/{id}/plan",
      "PATCH /api/initiatives/{id}/plan",
      "POST /api/initiatives/{id}/activate",
      "GET /api/initiatives/{id}/resume",
      "GET /api/initiatives/{id}/reviews",
      "POST /api/initiatives/{id}/reviews",
    ].map((endpoint) => {
      const [method, path] = endpoint.split(" ");
      const scope = requiredScope(path, method);
      return {
        endpoint,
        required_access: scope
          ? "Bearer " +
            (scope === "jobs:claim" || scope === "jobs:update"
              ? "worker-only"
              : "Instinct") +
            " credential: " +
            scope
          : endpoint === "GET /auth-check"
            ? "Bearer key"
            : "public",
      };
    }),
  };
  const headers = { "Cache-Control": "no-store", Vary: "Accept" };
  if (prefersHtml(request.headers.get("accept") ?? "")) {
    const section = (title: string, items: readonly string[]) =>
      "<h2>" +
      escapeHtml(title) +
      "</h2><ul>" +
      items.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") +
      "</ul>";
    const content =
      "<p>" +
      escapeHtml(descriptor.service) +
      "</p>" +
      section("Descriptor status", [descriptor.descriptor_status]) +
      section("Architecture", Object.values(descriptor.architecture)) +
      section("Task types", descriptor.task_types) +
      section("Authentication", [
        descriptor.authentication.scheme,
        descriptor.authentication.description,
      ]) +
      section("Scopes", descriptor.authentication.scopes) +
      section(
        "Credential scopes",
        Object.entries(descriptor.authentication.credential_scopes).map(
          ([credential, scopes]) => credential + ": " + scopes.join(", "),
        ),
      ) +
      section("Capabilities", descriptor.capabilities) +
      section("Development", descriptor.development) +
      section("Limitations", descriptor.limitations) +
      '<h2>Endpoints</h2><table><thead><tr><th scope="col">Endpoint</th><th scope="col">Required access</th></tr></thead><tbody>' +
      descriptor.endpoints
        .map(
          ({ endpoint, required_access }) =>
            "<tr><td><code>" +
            escapeHtml(endpoint) +
            "</code></td><td>" +
            escapeHtml(required_access) +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table>";
    return new Response(
      publicPage(
        "Conduit capabilities",
        `<p class="eyebrow">Product & API reference</p><h1>Conduit capabilities</h1>${content}`,
      ),
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  return Response.json(descriptor, { headers });
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function prefersHtml(accept: string): boolean {
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((entry) => {
      const [type, ...parameters] = entry.trim().split(";");
      const q = parameters.find((parameter) =>
        parameter.trim().startsWith("q="),
      );
      const quality = q ? Number(q.trim().slice(2)) : 1;
      return {
        type,
        quality:
          Number.isFinite(quality) && quality >= 0 && quality <= 1
            ? quality
            : 0,
      };
    });
  const quality = (type: string) => {
    for (const match of [type, `${type.split("/")[0]}/*`, "*/*"]) {
      const matches = ranges.filter((range) => range.type === match);
      if (matches.length)
        return Math.max(...matches.map((range) => range.quality));
    }
    return 0;
  };
  return quality("text/html") > quality("application/json");
}
