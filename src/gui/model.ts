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
// Revisions use explicit roots only. Valid creation dates outrank invalid ones;
// lexical IDs break ties. Execution retries within a job are not revisions.
export function attemptRoot(j: Job) {
  return j.root_job_id || j.id;
}
function timestamp(value: string) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : -Infinity;
}
function compareAttempts(a: Job, b: Job) {
  const at = timestamp(a.created_at),
    bt = timestamp(b.created_at);
  return (
    (at === bt ? 0 : at > bt ? 1 : -1) ||
    (a.id === b.id ? 0 : a.id > b.id ? 1 : -1)
  );
}
export const triageFilters = {
  all: "All",
  running: "Running",
  waiting: "Waiting",
  review: "Review",
  failed: "Failed/blocked",
} as const;
export type TriageFilter = keyof typeof triageFilters;
export function triageFilter(value?: string | null): TriageFilter {
  return value && Object.hasOwn(triageFilters, value)
    ? (value as TriageFilter)
    : "all";
}
export function dashboardUrl(current: string, name: string, value: string) {
  const url = new URL(current);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  return url.href;
}
export function hasOpenReview(detail?: Detail) {
  const p = detail?.publication,
    pr = p?.pull_request;
  return (
    p?.publication_state === "published" && pr?.state === "open" && !pr.merged
  );
}
export function deriveTriage(jobs: Job[], scope?: string) {
  const roots = new Map<string, Job>();
  for (const j of jobs) {
    const root = attemptRoot(j),
      previous = roots.get(root);
    if (!previous || compareAttempts(j, previous) > 0) roots.set(root, j);
  }
  return {
    jobs: (scope === "all" ? [...jobs] : [...roots.values()]).sort(
      (a, b) => -compareAttempts(a, b),
    ),
    hidden: jobs.length - roots.size,
  };
}
export function filterTriage(
  jobs: Job[],
  details: Record<string, Detail>,
  filter: TriageFilter,
  search = "",
) {
  return jobs.filter(
    (j) =>
      (filter === "all" ||
        (filter === "running" && j.status === "running") ||
        (filter === "waiting" && j.status === "waiting_dependencies") ||
        (filter === "review" && hasOpenReview(details[j.id])) ||
        (filter === "failed" && ["failed", "blocked"].includes(j.status))) &&
      `${j.title} ${j.id} ${j.status}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}
export const needGroups = [
  "Recovery / failure",
  "Dependencies",
  "Review",
  "Worker health",
] as const;
export type Need = {
  id: string;
  job?: Job;
  relatedJobs?: Job[];
  severity: number;
  group: (typeof needGroups)[number];
  why: string;
  heading?: string;
  date: string;
  url?: string;
  command?: string;
};
export function needsYou(
  jobs: Job[],
  workers: Worker[],
  details: Record<string, Detail>,
  now = Date.now(),
  scope = "latest",
): Need[] {
  const items: Need[] = [];
  const reviewed = new Set<string>();
  const scoped = deriveTriage(jobs, scope).jobs;
  const dependencies = new Map<string, Need>();
  const dependencyIds = new Set(
    scoped
      .filter((j) => j.status === "waiting_dependencies")
      .flatMap((j) => j.dependency_job_ids ?? []),
  );
  for (const j of scoped) {
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
        group:
          severity === 0
            ? "Recovery / failure"
            : severity === 2
              ? "Review"
              : "Dependencies",
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
      hasOpenReview(details[j.id]) &&
      pr &&
      !dependencyIds.has(j.id) &&
      !reviewed.has(root)
    ) {
      reviewed.add(root);
      add(
        "review",
        2,
        `${pr.draft ? "Draft PR" : "PR"} #${pr.number} awaits review (not merge approval)`,
        {
          url: githubUrl(pr.url),
          date: p.updated_at ?? j.created_at,
        },
      );
    }
    if (j.status === "waiting_dependencies" && !j.dependency_job_ids?.length)
      add("dependency", 1, "Waiting on dependencies; IDs not reported");
    if (j.status === "waiting_dependencies")
      for (const id of j.dependency_job_ids ?? []) {
        const existing = dependencies.get(id);
        if (existing) {
          if (
            existing.job?.id !== j.id &&
            !existing.relatedJobs?.some((v) => v.id === j.id)
          )
            (existing.relatedJobs ??= []).push(j);
          continue;
        }
        const dep = details[id]?.publication?.pull_request;
        if (dep && !dep.merged) {
          add(
            id,
            1,
            dep.state === "open"
              ? `Dependency ${id}: review PR #${dep.number}; merge is required upstream`
              : `Dependency ${id}: PR #${dep.number} closed and unmerged`,
            {
              url: githubUrl(dep.url),
              heading: `Dependency ${dep.state === "open" ? "review" : "closed and unmerged"} · PR #${dep.number} · ${id.slice(0, 8)}`,
            },
          );
        } else {
          add(
            id,
            1,
            `Waiting on dependency ${id}; ${dep?.merged ? "PR reported merged, job still waiting" : "publication evidence unavailable"}`,
            {
              heading: `Dependency ${dep?.merged ? `merged; still waiting · PR #${dep.number}` : "evidence unavailable"} · ${id.slice(0, 8)}`,
            },
          );
        }
        dependencies.set(id, items[items.length - 1]);
      }
  }
  if (scoped.some((j) => j.status === "queued"))
    for (const w of workers)
      if (!w.available || stale(w, now))
        items.push({
          id: w.worker_id,
          severity: 1,
          group: "Worker health",
          why: `Worker ${w.worker_id} is offline while jobs are queued`,
          date: w.last_seen_at,
        });
  return items.sort(
    (a, b) =>
      a.severity - b.severity ||
      (timestamp(a.date) > timestamp(b.date)
        ? 1
        : timestamp(a.date) < timestamp(b.date)
          ? -1
          : a.id.localeCompare(b.id)),
  );
}
