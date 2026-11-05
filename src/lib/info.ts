import { SCOPES, credentialScopes } from "./keys";

// All inputs are explicit; describing the service needs no database or environment.
export function info(request: Request): Response {
  const descriptor = {
    service: "Conduit POC",
    architecture: {
      api: "Authenticated HTTP job API hosted on Vercel using Next.js",
      queue: "Supabase PostgreSQL persistent job queue",
      worker: "Local outbound worker that claims and executes jobs",
    },
    task_types: [
      "simulate-development",
      "simulate-failure",
      "codex_task",
      "development",
    ],
    authentication: {
      scheme: "Bearer",
      description: "Persistent API keys with scoped permissions",
      scopes: [...SCOPES],
      credential_scopes: credentialScopes,
    },
    capabilities: [
      "Idempotent job creation via Idempotency-Key",
      "Job status and result retrieval",
      "Worker availability reporting",
    ],
    development: [
      "Registered GitHub projects",
      "Isolated worktrees",
      "Real Codex execution",
      "Verification checks",
      "Draft pull requests",
      "Same-PR revisions",
      "Changes, diff, and publication retrieval",
    ],
    endpoints: [
      "GET /",
      "GET /info",
      "GET /health",
      "GET /auth-check",
      "GET /api/jobs",
      "POST /api/jobs",
      "GET /api/jobs/{id}",
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
    ],
  };
  const headers = { "Cache-Control": "no-store", Vary: "Accept" };
  if (prefersHtml(request.headers.get("accept") ?? "")) {
    const content = JSON.stringify(descriptor, null, 2).replace(
      /[&<>]/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
    );
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conduit capabilities</title></head><body><h1>Conduit capabilities</h1><pre style="white-space:pre-wrap">${content}</pre></body></html>`,
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  return Response.json(descriptor, { headers });
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
