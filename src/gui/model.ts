export type Job = {
  id: string;
  title: string;
  status: string;
  task?: string;
  description?: string;
  instructions?: string | null;
  acceptance_criteria?: string | null;
  project?: string | null;
  project_id?: string | null;
  base_branch?: string | null;
  root_job_id?: string | null;
  dependency_job_ids?: string[];
  phase?: string | null;
  progress: number;
  attempt_count: number;
  worker_id?: string | null;
  created_at: string;
  claimed_at?: string | null;
  completed_at?: string | null;
  lease_expires_at?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
};
export type Worker = {
  worker_id: string;
  available: boolean;
  busy: boolean;
  last_seen_at: string;
};
export type Publication = {
  publication_state: string;
  branch?: string | null;
  head_commit?: string | null;
  pull_request_observed_at?: string | null;
  updated_at?: string;
  pull_request?: {
    url: string;
    number: number;
    state: string;
    draft: boolean;
    merged: boolean;
  } | null;
};
export type Execution = {
  attempt: number;
  status: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  result?: Record<string, unknown>;
};
export type ActivityEvent = {
  id: string;
  type: string;
  occurred_at: string;
  data: { phase?: string; attempt?: number; number?: number };
};
export type Detail = {
  publication?: Publication | null;
  executions?: Execution[];
  files?: unknown[];
  errors?: string[];
};
export const columns = [
  "Queued",
  "In progress",
  "Completed",
  "Failed / blocked",
  "Unknown status",
];
export function column(s: string) {
  return (
    (
      {
        queued: "Queued",
        waiting_dependencies: "Queued",
        running: "In progress",
        completed: "Completed",
        failed: "Failed / blocked",
        blocked: "Failed / blocked",
      } as Record<string, string>
    )[s] ?? "Unknown status"
  );
}
export function stale(w: Worker, now = Date.now()) {
  return (
    !Number.isFinite(Date.parse(w.last_seen_at)) ||
    now - Date.parse(w.last_seen_at) > 15000
  );
}
export function githubUrl(value: unknown): string | undefined {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" &&
      u.hostname === "github.com" &&
      !u.username &&
      !u.password &&
      !u.port
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function dependencyLabel(j: Job) {
  const ids = j.dependency_job_ids ?? [];
  return `Waiting on ${ids.length} job(s): ${ids.join(", ") || "ids not reported"}`;
}
export function age(value?: string | null, now = Date.now()) {
  if (!value) return "not reported";
  const n = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  return !Number.isFinite(n)
    ? "unknown"
    : n < 60
      ? `${n}s ago`
      : n < 3600
        ? `${Math.floor(n / 60)}m ago`
        : `${Math.floor(n / 3600)}h ago`;
}
export type Need = {
  id: string;
  job?: Job;
  severity: number;
  why: string;
  date: string;
  url?: string;
  command?: string;
};
export function needsYou(
  jobs: Job[],
  workers: Worker[],
  details: Record<string, Detail>,
  now = Date.now(),
): Need[] {
  const items: Need[] = [];
  const reviewed = new Set<string>();
  for (const j of jobs) {
    const add = (
      suffix: string,
      severity: number,
      why: string,
      extra: Partial<Need> = {},
    ) =>
      items.push({
        id: j.id + suffix,
        job: j,
        severity,
        why,
        date: j.completed_at ?? j.created_at,
        ...extra,
      });
    if (["failed", "blocked"].includes(j.status))
      add("failure", 0, `${j.status}: ${j.error || "No error text reported"}`);
    if (j.result?.recovery_required === true)
      add("recovery", 0, "Recovery required. Inspect the reported result.", {
        command: `npm run development:admin -- inspect --job-id ${j.id}`,
      });
    const p = details[j.id]?.publication,
      pr = p?.pull_request,
      root = j.root_job_id || j.id;
    if (
      p?.publication_state === "published" &&
      pr?.state === "open" &&
      pr.draft &&
      !pr.merged &&
      !reviewed.has(root)
    ) {
      reviewed.add(root);
      add("review", 2, `Draft PR #${pr.number} awaits review / merge`, {
        url: githubUrl(pr.url),
        date: p.updated_at ?? j.created_at,
      });
    }
    if (j.status === "waiting_dependencies")
      for (const id of j.dependency_job_ids ?? []) {
        const dep = details[id]?.publication?.pull_request;
        if (dep && !dep.merged)
          add(
            id,
            1,
            dep.state === "open"
              ? `Merge PR #${dep.number} to unblock dependency ${id}`
              : `Dependency ${id}: PR #${dep.number} closed and unmerged`,
            { url: githubUrl(dep.url) },
          );
      }
  }
  if (jobs.some((j) => column(j.status) === "Queued"))
    for (const w of workers)
      if (!w.available || stale(w, now))
        items.push({
          id: w.worker_id,
          severity: 1,
          why: `Worker ${w.worker_id} is offline while jobs are queued`,
          date: w.last_seen_at,
        });
  return items.sort(
    (a, b) =>
      a.severity - b.severity || Date.parse(a.date) - Date.parse(b.date),
  );
}
