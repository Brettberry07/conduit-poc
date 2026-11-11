"use client";
import Link from "next/link";
import { authRequest, connectEmail, readApi, sessionClient } from "./auth";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  age,
  column,
  columns,
  githubUrl,
  needsYou,
  deriveTriage,
  filterTriage,
  triageFilter,
  triageFilters,
  hasOpenReview,
  needGroups,
  dashboardUrl,
  stale,
  type Job,
  type Worker,
  type Detail,
  type ActivityEvent,
} from "./model";
export type ConsoleData = {
  jobs: Job[];
  workers: Worker[];
  details: Record<string, Detail>;
  now: number;
  select: (j: Job) => void;
  search: string;
  setSearch: (s: string) => void;
  loading: boolean;
  updated: number;
  error: string;
  paused: boolean;
  scope?: string;
  statusFilter?: string;
  setTriage?: (name: string, value: string) => void;
};
export const ConsoleContext = createContext<ConsoleData>(null!);
const Context = ConsoleContext;
const iconPaths = {
  brand: "M3 12V4h8M3 4l10 8M7 12h6V6",
  board: "M2 3h12v10H2zM6 3v10M10 3v10",
  active: "M1 8h3l2-5 4 10 2-5h3",
  review: "M8 2l6 6-6 6-6-6zM8 5v3M8 11h.01",
  sidebar: "M2 3h12v10H2zM6 3v10",
  connection: "M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  search: "M10.5 10.5L14 14M11 6.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0",
  external: "M9 2h5v5M14 2L7 9M6 3H2v11h11v-4",
  pullRequest:
    "M4 5v6M12 11V7a4 4 0 0 0-4-4M9 1L7 3l2 2M6 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0M14 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  close: "M4 4l8 8M12 4l-8 8",
  queued: "M8 3v5l3 2M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0",
  running: "M6 3l7 5-7 5z",
  completed: "M3 8l3 3 7-7",
  failed: "M8 2l6 3v5l-6 4-6-4V5zM6 6l4 4M10 6l-4 4",
  blocked: "M3 3h10v10H3zM5 8h6",
  arrow: "M2 8h12M9 3l5 5-5 5",
};
function Icon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}
const routes = [
  ["board", "board", "Job board"],
  ["active", "active", "Active"],
  ["needs-you", "review", "Needs you"],
] as const;
function message(e: unknown) {
  return e instanceof Error ? e.message : "Connection unavailable";
}
function Modal({
  children,
  label,
  close,
  sheet = false,
}: {
  children: React.ReactNode;
  label: string;
  close: () => void;
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const dialog = ref.current!;
    const body = document.body;
    const root = document.documentElement;
    const { scrollX, scrollY } = window;
    const bodyStyle = body.getAttribute("style");
    const overflow = root.style.overflow;
    const scrollBehavior = root.style.scrollBehavior;
    // Preserve the visible page on touch browsers and prevent programmatic
    // root scrolling as well as wheel/touch scrolling.
    Object.assign(body.style, {
      position: "fixed",
      top: `-${scrollY}px`,
      left: `-${scrollX}px`,
      width: "100%",
      overflow: "hidden",
    });
    root.style.overflow = "clip";
    dialog.showModal();
    return () => {
      dialog.close();
      if (bodyStyle === null) body.removeAttribute("style");
      else body.setAttribute("style", bodyStyle);
      root.style.overflow = overflow;
      root.style.scrollBehavior = "auto";
      window.scrollTo(scrollX, scrollY);
      root.style.scrollBehavior = scrollBehavior;
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={sheet ? "sheet" : ""}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const dialog = e.currentTarget;
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            !element.closest("[inert]") &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden",
        );
        // Handle every Tab so native traversal cannot visit the page body.
        e.preventDefault();
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey
          ? (current <= 0 ? controls.length : current) - 1
          : (current + 1) % controls.length;
        (controls[next] ?? dialog).focus();
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <button className="close" aria-label="Close" onClick={close}>
        <Icon name="close" />
      </button>
      {children}
    </dialog>
  );
}
export function Shell({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState(false);
  const auth = useRef<ReturnType<typeof sessionClient> | null>(null);
  const [key, setKey] = useState(""),
    [draft, setDraft] = useState(""),
    [connecting, setConnecting] = useState(false),
    [connectError, setConnectError] = useState("");
  if (!auth.current)
    auth.current = sessionClient((session) => {
      setAccount(!!session);
      setKey(session?.access_token ?? "");
      setJobs([]);
      setWorkers([]);
      setDetails({});
      setUpdated(0);
      setError("");
    });
  const read = useCallback(
    (path: string, token: string, signal: AbortSignal) =>
      readApi(path, token, signal, (path, init, token) =>
        /^cnd_live_/.test(token)
          ? fetch(path, init)
          : auth.current!.fetch(path, init, token),
      ),
    [],
  );
  useEffect(() => {
    if (authRequest("password", {})) auth.current!.restore();
  }, []);
  async function emailConnect(action: "password" | "signup") {
    setConnecting(true);
    setConnectError("");
    try {
      const result = await connectEmail(
        action,
        email,
        password,
        auth.current!.save,
      );
      setConnectError(result);
      if (!result) setPassword("");
    } catch (e) {
      setConnectError(message(e));
    } finally {
      setConnecting(false);
    }
  }
  const [jobs, setJobs] = useState<Job[]>([]),
    [workers, setWorkers] = useState<Worker[]>([]),
    [details, setDetails] = useState<Record<string, Detail>>({}),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState(0),
    [loading, setLoading] = useState(false),
    [now, setNow] = useState(Date.now()),
    [paused, setPaused] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [palette, setPalette] = useState(false);
  const pathname = usePathname(),
    router = useRouter(),
    params = useSearchParams();
  const search = params.get("filter") ?? "";
  const scope = params.get("attempts") === "all" ? "all" : "latest";
  const statusFilter = triageFilter(params.get("status"));
  const selected = jobs.find((j) => j.id === params.get("job")) ?? null;
  function updateUrl(name: string, value: string) {
    window.history.pushState(
      null,
      "",
      dashboardUrl(window.location.href, name, value),
    );
  }
  const setSearch = (value: string) => updateUrl("filter", value);
  const setSelected = (job: Job | null) => updateUrl("job", job?.id ?? "");
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    if (!key) return;
    let stopped = false,
      busy = false;
    let controller = new AbortController();
    async function poll() {
      if (document.hidden || busy || stopped) return;
      busy = true;
      controller = new AbortController();
      setLoading(true);
      try {
        const [j, w] = await Promise.all([
          read("/api/jobs?limit=100", key, controller.signal),
          read("/api/workers", key, controller.signal),
        ]);
        const next: Record<string, Detail> = {};
        const ids = [
          ...new Set<string>(
            j.jobs.flatMap((job: Job) => [
              job.id,
              ...(job.dependency_job_ids ?? []),
            ]),
          ),
        ];
        let cursor = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (cursor < ids.length) {
              const id = ids[cursor++],
                job = j.jobs.find((v: Job) => v.id === id),
                d: Detail = { errors: [] };
              await Promise.all(
                (job?.status === "running"
                  ? ["publication", "executions"]
                  : ["publication"]
                ).map(async (op) => {
                  try {
                    Object.assign(
                      d,
                      await read(
                        `/api/jobs/${encodeURIComponent(id)}/${op}`,
                        key,
                        controller.signal,
                      ),
                    );
                  } catch (e) {
                    d.errors!.push(`${op}: ${message(e)}`);
                  }
                }),
              );
              next[id] = d;
            }
          }),
        );
        if (!stopped && !controller.signal.aborted) {
          setJobs(j.jobs);
          setWorkers(w.workers);
          setDetails(next);
          setUpdated(Date.now());
          setError(
            Object.values(next).some((d) =>
              d.errors?.some((e) => !e.includes("Not available")),
            )
              ? "Some job details could not be refreshed. Review data may be incomplete."
              : "",
          );
        }
      } catch (e) {
        if (!stopped && !controller.signal.aborted) {
          setError(message(e));
          if (
            message(e) ===
            "This account isn't linked to any Conduit workspace yet."
          ) {
            setJobs([]);
            setWorkers([]);
            setDetails({});
            setUpdated(0);
          }
        }
      } finally {
        busy = false;
        if (!stopped) setLoading(false);
      }
    }
    const visibility = () => {
      setPaused(document.hidden);
      if (document.hidden) controller.abort();
      else void poll();
    };
    setPaused(document.hidden);
    void poll();
    const t = setInterval(poll, 3000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(t);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key]);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setConnectError("");
    try {
      await read("/api/workers", draft.trim(), new AbortController().signal);
      setKey(draft.trim());
      setDraft("");
    } catch (e) {
      setConnectError(message(e));
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = () => {
    setKey("");
    setJobs([]);
    setWorkers([]);
    setDetails({});
    setUpdated(0);
    setError("");
  };
  const triage = deriveTriage(jobs, scope);
  const needs = needsYou(jobs, workers, details, now, scope),
    counts = [
      triage.jobs.length,
      jobs.filter((j) => j.status === "running").length,
      needs.length,
    ];
  return (
    <Context.Provider
      value={{
        jobs,
        workers,
        details,
        now,
        select: setSelected,
        search,
        setSearch,
        loading,
        updated,
        error,
        paused,
        scope,
        statusFilter,
        setTriage: updateUrl,
      }}
    >
      <div className={`console ${collapsed ? "collapsed" : ""}`}>
        <a className="skip" href="#content">
          Skip to content
        </a>
        <aside className="sidebar">
          <div className="brand">
            <span className="mark">
              <Icon name="brand" />
            </span>
            <strong>Conduit</strong>
            <button
              onClick={() => setCollapsed((v) => !v)}
              aria-label="Toggle sidebar"
              aria-expanded={!collapsed}
            >
              <Icon name="sidebar" />
            </button>
          </div>
          <p className="eyebrow">WORKSPACE</p>
          <nav aria-label="Main">
            {routes.map(([route, icon, label], i) => (
              <Link
                key={route}
                href={`/app/${route}${params.size ? `?${params}` : ""}`}
                aria-label={label}
                aria-current={pathname === `/app/${route}` ? "page" : undefined}
              >
                <Icon name={icon} />
                <span className="nav-label">{label}</span>
                <b
                  aria-label={`${counts[i]} ${["jobs", "running", "needs you"][i]}`}
                >
                  {counts[i]}
                </b>
              </Link>
            ))}
          </nav>
          <div className="pinned">
            <p className="eyebrow">PINNED</p>
            <span className="pill">
              <Icon name="connection" />{" "}
              {key ? "Read-only connection" : "Disconnected"}
            </span>
            <p>
              {workers.filter((w) => w.available && !stale(w, now)).length}{" "}
              workers available
            </p>
            {key && (
              <button
                onClick={() =>
                  account
                    ? void auth
                        .current!.logout()
                        .catch(() =>
                          setConnectError(
                            "Signed out locally; remote logout failed.",
                          ),
                        )
                    : disconnect()
                }
              >
                {account ? "Sign out" : "Disconnect"}
              </button>
            )}
          </div>
          <footer>
            Cmd / Ctrl K · Jump
            <br />
            Cmd / Ctrl B · Sidebar
          </footer>
        </aside>
        <main id="content" className="surface">
          {!key ? (
            <section className="connect">
              <span className="mark">
                <Icon name="brand" />
              </span>
              <p className="eyebrow">YOUR WORK, IN VIEW</p>
              <h1>Connect to Conduit</h1>
              {authRequest("password", {}) ? (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void emailConnect("password");
                    }}
                  >
                    <label htmlFor="email">Email</label>
                    <input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                    <label htmlFor="password">Password</label>
                    <input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button className="primary" disabled={connecting}>
                      Sign in
                    </button>
                    <button
                      disabled={connecting}
                      type="submit"
                      onClick={(e) => {
                        e.preventDefault();
                        if (e.currentTarget.form?.reportValidity())
                          void emailConnect("signup");
                      }}
                    >
                      Sign up
                    </button>
                  </form>
                  <p>
                    Email sessions persist in localStorage across refreshes.
                    Workspace access requires an administrator to link your
                    account. Or paste a memory-only read-only key below.
                  </p>
                </>
              ) : (
                <p>
                  Email sign-in is not configured. Connect using a read-only
                  key.
                </p>
              )}
              <p>
                A quiet place to follow jobs, workers, and the decisions waiting
                for you.
              </p>
              <form onSubmit={connect}>
                <label htmlFor="key">Read-only Instinct key · jobs:read</label>
                <input
                  id="key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  required
                />
                <button className="primary" disabled={connecting}>
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              </form>
              <p>
                Held in React memory only. Refreshing or disconnecting forgets
                your key. All requests are same-origin GET reads.
              </p>
              {connectError && (
                <p role="alert" className="banner">
                  {connectError}
                </p>
              )}
            </section>
          ) : (
            <>
              <div className="topline">
                <span>
                  Workspace · {routes.find((r) => pathname.endsWith(r[0]))?.[2]}
                </span>
                <span>
                  {updated
                    ? `Updated ${age(new Date(updated).toISOString(), now)}`
                    : "Loading…"}
                </span>
                <button onClick={() => setPalette(true)}>
                  <Icon name="search" /> Command K
                </button>
              </div>
              <p
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {error
                  ? "Workspace refresh failed."
                  : updated
                    ? `${jobs.length} jobs loaded. ${counts[1]} running. ${needs.length} items need attention.`
                    : "Loading workspace."}
              </p>
              {(error || paused) && (
                <p className="banner" role="status">
                  {paused
                    ? "Reads paused while this tab is hidden. Updates resume when you return."
                    : `Refresh failed: ${error} Reads retry every 3 seconds while visible.`}
                  {updated ? " Last successful data is retained." : ""}
                </p>
              )}
              {updated > 0 && params.get("job") && !selected && (
                <p className="banner" role="status">
                  The linked job is not in the latest 100 loaded jobs.{" "}
                  <button onClick={() => setSelected(null)}>Dismiss</button>
                </p>
              )}
              {children}
            </>
          )}
        </main>
        {palette && (
          <Modal label="Jump or filter jobs" close={() => setPalette(false)}>
            <h2>Go somewhere</h2>
            <label htmlFor="command">Filter jobs by title, id or status</label>
            <input
              id="command"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  router.push(
                    `/app/board?${new URLSearchParams(window.location.search)}`,
                  );
                  setPalette(false);
                }
              }}
            />
            {routes.map(([route, icon, label]) => (
              <button
                className="command"
                key={route}
                onClick={() => {
                  router.push(
                    `/app/${route}?${new URLSearchParams(window.location.search)}`,
                  );
                  setPalette(false);
                }}
              >
                <Icon name={icon} /> {label} <Icon name="arrow" />
              </button>
            ))}
          </Modal>
        )}
        {selected && key && (
          <JobDetail
            key={selected.id}
            read={read}
            job={jobs.find((j) => j.id === selected.id) ?? selected}
            apiKey={key}
            close={() => setSelected(null)}
          />
        )}
      </div>
    </Context.Provider>
  );
}
function Github({ url }: { url: unknown }) {
  const safe = githubUrl(url);
  return safe ? (
    <a href={safe} target="_blank" rel="noreferrer noopener">
      Open on GitHub <Icon name="external" />
    </a>
  ) : null;
}
function Json({ value }: { value: unknown }) {
  return (
    <details className="raw-data">
      <summary>Raw JSON</summary>
      <pre tabIndex={0}>{JSON.stringify(value, null, 2) ?? "Not reported"}</pre>
    </details>
  );
}
function RelativeTime({ value }: { value?: string | null }) {
  const { now } = useContext(Context) ?? {};
  return value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {age(value, now)}
    </time>
  ) : (
    <span className="muted">Not reported</span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const known = [
    "queued",
    "running",
    "review",
    "completed",
    "failed",
    "blocked",
  ] as const;
  const kind =
    known.find((v) => v === status) ??
    (status === "waiting_dependencies" ? "blocked" : "queued");
  const label =
    status === "review"
      ? "Awaiting review"
      : status === "waiting_dependencies"
        ? "Waiting on dependencies"
        : status.replaceAll("_", " ");
  return (
    <span className={`status-badge status-${kind}`}>
      <Icon name={kind === "review" ? "review" : kind} />
      {label}
    </span>
  );
}
function JobCard({ job }: { job: Job }) {
  const c = useContext(Context);
  const review = hasOpenReview(c.details[job.id]);
  return (
    <article className="job">
      <button className="job-open" onClick={() => c.select(job)}>
        <h3 title={job.title}>{job.title}</h3>
        <StatusBadge status={job.status} />
        {review && <StatusBadge status="review" />}
        <span className="job-meta">
          <code>{job.id.slice(0, 8)}</code>
          <RelativeTime value={job.created_at} />
        </span>
        {job.status === "running" && (
          <div className="job-progress">
            <span>{job.phase ?? "In progress"}</span>
            <span>{job.progress}%</span>
            <progress
              max={100}
              value={job.progress}
              aria-label="Job progress"
            />
          </div>
        )}
      </button>
    </article>
  );
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
export function Checks({
  result,
}: {
  result?: Record<string, unknown> | null;
}) {
  const verification = record(result?.verification);
  const checks = verification.checks ?? result?.checks;
  return Array.isArray(checks) && checks.length ? (
    <ul className="check-list">
      {checks.map((v, i) => {
        const x = record(v);
        const state =
          x.timed_out === true
            ? "failed"
            : x.status === "skipped" || x.skipped === true
              ? "skipped"
              : typeof x.exit_code === "number"
                ? x.exit_code === 0
                  ? "passed"
                  : "failed"
                : "not reported";
        return (
          <li key={i} className={`check-${state.replaceAll(" ", "-")}`}>
            <Icon
              name={
                state === "passed"
                  ? "completed"
                  : state === "failed"
                    ? "failed"
                    : "blocked"
              }
            />
            <span>{String(x.name ?? x.command ?? "Check")}</span>
            <strong>{x.timed_out === true ? "Timed out" : state}</strong>
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="muted">
      Verification{" "}
      {String(verification.status ?? "not reported").replaceAll("_", " ")}. No
      checks reported.
    </p>
  );
}
export function Timeline({ job, detail }: { job: Job; detail?: Detail }) {
  return (
    <section className="timeline">
      <h2>Execution timeline</h2>
      <p className="muted">Current phase · {job.phase ?? "Not reported"}</p>
      <ol>
        <li>
          <Icon name="queued" />
          <div>
            <strong>Queued</strong>
            <RelativeTime value={job.created_at} />
          </div>
        </li>
        {job.claimed_at && (
          <li>
            <Icon name="running" />
            <div>
              <strong>Claimed by worker</strong>
              <RelativeTime value={job.claimed_at} />
            </div>
          </li>
        )}
        {detail?.executions?.map((e) => (
          <li key={e.attempt}>
            <Icon
              name={
                e.status === "completed"
                  ? "completed"
                  : e.status === "failed"
                    ? "failed"
                    : e.status === "blocked"
                      ? "blocked"
                      : "running"
              }
            />
            <div>
              <strong>
                Attempt {e.attempt} · {e.status.replaceAll("_", " ")}
              </strong>
              <span>
                Started <RelativeTime value={e.started_at} />
                {e.completed_at && (
                  <>
                    {" "}
                    · Finished <RelativeTime value={e.completed_at} />
                  </>
                )}
              </span>
              {e.error && <p className="failure">{e.error}</p>}
              <Checks result={e.result} />
            </div>
          </li>
        ))}
      </ol>
      {!detail?.executions?.length && (
        <p className="muted">No execution attempts reported.</p>
      )}
    </section>
  );
}
export function PublicationPanel({
  publication,
}: {
  publication?: Detail["publication"];
}) {
  const pr = publication?.pull_request;
  const url = githubUrl(pr?.url);
  return (
    <section className="detail-panel">
      <h2>Publication</h2>
      <p>
        {publication?.publication_state?.replaceAll("_", " ") ?? "Not reported"}
      </p>
      {url && (
        <a
          className="pr-link"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <Icon name="pullRequest" />
          Pull request #{pr!.number}
          <Icon name="external" />
        </a>
      )}
      {pr && (
        <p className="muted">
          {pr.merged ? "Merged" : `${pr.draft ? "Draft · " : ""}${pr.state}`}
        </p>
      )}
      <dl>
        <dt>Branch</dt>
        <dd>
          <code>{publication?.branch ?? "Not reported"}</code>
        </dd>
        <dt>Head commit</dt>
        <dd>
          <code title={publication?.head_commit ?? undefined}>
            {publication?.head_commit?.slice(0, 8) ?? "Not reported"}
          </code>
        </dd>
        <dt>PR observed</dt>
        <dd>
          <RelativeTime value={publication?.pull_request_observed_at} />
        </dd>
      </dl>
      <p className="muted">Recorded publication data. PR state is not live.</p>
    </section>
  );
}
export function ChangedFiles({ files }: { files?: Detail["files"] }) {
  if (!files) return <p className="muted">Changed files not reported.</p>;
  const entries = files.map(record);
  return (
    <section className="detail-panel">
      <h2>
        Changed files <span className="muted">{files.length}</span>
      </h2>
      <p className="file-counts">
        {[
          "added",
          "modified",
          "deleted",
          "renamed",
          "copied",
          "type_changed",
        ].map((status) => {
          const count = entries.filter((f) => f.status === status).length;
          return count || ["added", "modified", "deleted"].includes(status) ? (
            <span key={status}>
              {count} {status.replaceAll("_", " ")}
            </span>
          ) : null;
        })}
      </p>
      <ul className="file-list">
        {entries.map((f, i) => (
          <li key={i}>
            <code title={String(f.path)}>
              {String(f.path ?? "Unknown path")}
            </code>
            <span>{String(f.status ?? "Unknown")}</span>
          </li>
        ))}
      </ul>
      <p className="muted">Latest attempt · up to 100 files reported.</p>
    </section>
  );
}
function useDelayedLoading(loading: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(loading), loading ? 200 : 300);
    return () => clearTimeout(timer);
  }, [loading]);
  return visible;
}
function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <Icon name="board" />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
export function Screen({ view }: { view: string }) {
  const c = useContext(Context),
    needs = needsYou(c.jobs, c.workers, c.details, c.now, c.scope);
  const triage = deriveTriage(c.jobs, c.scope);
  const status = triageFilter(c.statusFilter);
  const visible = filterTriage(triage.jobs, c.details, status, c.search);
  const showSkeleton = useDelayedLoading(c.loading && !c.updated && !c.paused);
  return (
    <section className="screen">
      <header>
        <p className="eyebrow">CONDUIT · READ ONLY</p>
        <h1>
          {view === "board"
            ? "Job board"
            : view === "active"
              ? "Active workers"
              : "Needs you"}
        </h1>
        <p className="muted">
          {view === "board"
            ? "From the queue to a published result."
            : view === "active"
              ? "Worker status and reported activity. No live Codex stream."
              : "Decisions and recovery signals from reported data. No actions run here."}
        </p>
      </header>
      {view !== "active" && c.updated > 0 && (
        <div className="triage-controls">
          <label>
            Attempt scope{" "}
            <select
              value={c.scope === "all" ? "all" : "latest"}
              onChange={(e) =>
                c.setTriage?.("attempts", e.target.value === "all" ? "all" : "")
              }
            >
              <option value="latest">Latest loaded attempt per root</option>
              <option value="all">All attempts</option>
            </select>
          </label>
          <p className="muted">
            {triage.jobs.length} of {c.jobs.length} loaded attempts ·{" "}
            {c.scope === "all" ? 0 : triage.hidden} hidden by scope. Latest
            means within the loaded window (up to 100 jobs), not global history.
            {c.scope === "all" && ` ${triage.hidden} older attempts included.`}
          </p>
        </div>
      )}
      {!c.updated || (showSkeleton && !c.error && !c.paused) ? (
        <div className="initial-state" aria-busy={c.loading && !c.paused}>
          {c.paused ? (
            <EmptyState
              title="Updates paused"
              text="Reads resume when this tab is visible."
            />
          ) : c.error ? (
            <EmptyState
              title="Workspace could not be loaded"
              text="The read request failed. Retrying every 3 seconds while visible."
            />
          ) : showSkeleton ? (
            <div className="skeleton-grid" aria-label="Loading workspace">
              {[0, 1, 2].map((i) => (
                <div className="skeleton-card" key={i}>
                  <span />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : (
            <span className="sr-only">Loading workspace</span>
          )}
        </div>
      ) : view === "board" ? (
        <>
          <label className="search">
            <Icon name="search" />{" "}
            <input
              aria-label="Filter jobs by title id or status"
              placeholder="Filter by title, id, or status…"
              value={c.search}
              onChange={(e) => c.setSearch(e.target.value)}
            />
          </label>
          <div
            className="triage-filters"
            role="group"
            aria-label="Job status filters"
          >
            {Object.entries(triageFilters).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={status === key}
                onClick={() =>
                  c.setTriage?.("status", key === "all" ? "" : key)
                }
              >
                {label} (
                {filterTriage(triage.jobs, c.details, triageFilter(key)).length}
                )
              </button>
            ))}
          </div>
          <p className="muted">
            Review uses reported open, unmerged PR evidence; it is not merge
            approval.
          </p>
          <div className="board">
            {columns
              .filter(
                (name) =>
                  name !== "Unknown status" ||
                  triage.jobs.some((j) => column(j.status) === name),
              )
              .map((name) => {
                const list = visible.filter((j) => column(j.status) === name);
                return (
                  <section className="lane" data-status={name} key={name}>
                    <h2>
                      {name}
                      <span className="count">{list.length}</span>
                    </h2>
                    {list.map((j) => (
                      <JobCard key={j.id} job={j} />
                    ))}
                    {!list.length && (
                      <p className="empty">
                        {c.search || status !== "all"
                          ? "No matching jobs"
                          : "No jobs in this stage"}
                      </p>
                    )}
                  </section>
                );
              })}
          </div>
        </>
      ) : view === "active" ? (
        <div className="workers">
          {!c.workers.length && (
            <EmptyState
              title="No workers reported"
              text="Connected workers will appear here. Queued jobs need an available worker."
            />
          )}
          {c.workers.map((w) => {
            const list = c.jobs.filter(
                (j) => j.status === "running" && j.worker_id === w.worker_id,
              ),
              offline = !w.available || stale(w, c.now);
            return (
              <section className="worker" key={w.worker_id}>
                <h2 className="mono">{w.worker_id}</h2>
                <p
                  className={`worker-state ${offline ? "failure" : "healthy"}`}
                >
                  <Icon name={offline ? "blocked" : "completed"} />
                  {offline ? "Offline · stale" : "Available"} ·{" "}
                  {w.busy ? "Busy" : "Idle"}
                </p>
                <p>
                  Last seen {age(w.last_seen_at, c.now)}
                  {stale(w, c.now) && " · exceeds 15s freshness window"}
                </p>
                {list.length ? (
                  list.map((j) => (
                    <div key={j.id}>
                      <JobCard job={j} />
                      <p>
                        Lease:{" "}
                        {j.lease_expires_at
                          ? `${Math.max(0, Math.ceil((Date.parse(j.lease_expires_at) - c.now) / 1000))}s remaining`
                          : "not reported"}
                      </p>
                      <Timeline job={j} detail={c.details[j.id]} />
                    </div>
                  ))
                ) : (
                  <p className="empty">No running job</p>
                )}
              </section>
            );
          })}
          {c.jobs
            .filter(
              (j) =>
                j.status === "running" &&
                !c.workers.some((w) => w.worker_id === j.worker_id),
            )
            .map((j) => (
              <section className="worker" key={j.id}>
                <h2>Worker not reported: {j.worker_id ?? "unassigned"}</h2>
                <JobCard job={j} />
                <Timeline job={j} detail={c.details[j.id]} />
              </section>
            ))}
        </div>
      ) : (
        <div className="needs">
          {!needs.length && (
            <EmptyState
              title={
                c.error
                  ? "No attention items in retained data"
                  : "You are all caught up"
              }
              text={
                c.error
                  ? "Some reads failed. Review signals may be incomplete."
                  : "No decisions or recovery signals in the latest loaded jobs."
              }
            />
          )}
          {needGroups.map((group) => {
            const items = needs.filter((n) => n.group === group);
            return (
              items.length > 0 && (
                <section key={group} aria-label={group}>
                  <h2>
                    {group} <span className="count">{items.length}</span>
                  </h2>
                  {items.map((n) => (
                    <article
                      key={n.id}
                      className={`need severity-${n.severity}`}
                    >
                      {!n.job ? (
                        <span className="status-badge muted">Offline</span>
                      ) : (
                        <StatusBadge
                          status={n.severity === 2 ? "review" : n.job.status}
                        />
                      )}
                      <h2>{n.why}</h2>
                      {n.job && (
                        <p>
                          <button
                            className="need-job"
                            onClick={() => c.select(n.job!)}
                          >
                            {n.job.title} <code>{n.job.id.slice(0, 8)}</code>
                          </button>
                        </p>
                      )}
                      {n.relatedJobs?.map((job) => (
                        <p key={job.id}>
                          Also waiting:{" "}
                          <button
                            className="need-job"
                            onClick={() => c.select(job)}
                          >
                            {job.title} <code>{job.id.slice(0, 8)}</code>
                          </button>
                        </p>
                      ))}
                      <p className="muted">{age(n.date, c.now)}</p>
                      <Github url={n.url} />
                      {n.command && (
                        <>
                          <p>
                            Operator inspection command (copyable text only)
                          </p>
                          <pre tabIndex={0}>{n.command}</pre>
                        </>
                      )}
                    </article>
                  ))}
                </section>
              )
            );
          })}
        </div>
      )}
    </section>
  );
}
function JobActivity({
  events,
  error,
  publication,
}: {
  events: ActivityEvent[] | null;
  error: string;
  publication?: Detail["publication"];
}) {
  const pr = publication?.pull_request;
  return (
    <section className="timeline" aria-label="Recorded activity">
      <h2>Recorded activity</h2>
      {error && <p role="status">{error}</p>}
      {!events && !error && <p role="status">Loading activity…</p>}
      {events?.length === 0 && (
        <p>No activity has been recorded for this job.</p>
      )}
      {!!events?.length && (
        <>
          <p className="muted">Up to 20 recent events, oldest first.</p>
          <ol>
            {[...events].reverse().map((event) => (
              <li key={event.id}>
                <strong>{event.type.replace(/[._]/g, " ")}</strong>
                {event.data.phase && <> · {event.data.phase}</>}
                {(event.data.attempt ?? 0) > 0 && (
                  <> · attempt {event.data.attempt}</>
                )}
                {" · "}
                <RelativeTime value={event.occurred_at} />
                {pr && event.data.number === pr.number && (
                  <>
                    {" "}
                    · <Github url={pr.url} />
                  </>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
function JobDetail({
  job,
  apiKey,
  close,
  read,
}: {
  job: Job;
  apiKey: string;
  close: () => void;
  read: (path: string, token: string, signal: AbortSignal) => Promise<any>;
}) {
  const { details } = useContext(Context);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [activityError, setActivityError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    let busy = false;
    async function refresh() {
      if (a.signal.aborted || document.hidden || busy) return;
      busy = true;
      try {
        const { events } = await read(
          `/api/agent/events?job_id=${encodeURIComponent(job.id)}&limit=20`,
          apiKey,
          a.signal,
        );
        if (!a.signal.aborted) {
          setEvents(events);
          setActivityError("");
        }
      } catch {
        if (!a.signal.aborted)
          setActivityError("Activity is temporarily unavailable.");
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      a.abort();
      clearInterval(timer);
    };
  }, [job.id, apiKey, read]);
  useEffect(() => {
    const a = new AbortController();
    const d: Detail = { errors: [] };
    void Promise.all(
      ["executions", "changes", "publication"].map(async (op) => {
        try {
          Object.assign(
            d,
            await read(
              `/api/jobs/${encodeURIComponent(job.id)}/${op}`,
              apiKey,
              a.signal,
            ),
          );
        } catch (e) {
          d.errors!.push(`${op}: ${message(e)}`);
        }
      }),
    ).then(() => {
      if (!a.signal.aborted) setDetail(d);
    });
    return () => a.abort();
  }, [job.id, apiKey]);
  return (
    <Modal label={`Job details: ${job.title}`} close={close} sheet>
      <p className="eyebrow">JOB DETAIL · {job.status}</p>
      <h1>{job.title}</h1>
      <code>{job.id}</code>
      <JobActivity
        events={events}
        error={activityError}
        publication={details[job.id]?.publication ?? detail?.publication}
      />
      <h2>Instructions</h2>
      <p className="detail-prose">
        {job.instructions ?? job.description ?? "Not reported"}
      </p>
      <h2>Acceptance criteria</h2>
      <p className="detail-prose">
        {job.acceptance_criteria ?? "Not reported"}
      </p>
      <h2>Result & verification</h2>
      <p className="detail-prose">
        {typeof job.result?.summary === "string"
          ? job.result.summary
          : "No result summary reported."}
      </p>
      <Checks result={job.result} />
      {job.error && (
        <section className="detail-panel failure">
          <h2>Error</h2>
          <p className="detail-prose">{job.error}</p>
        </section>
      )}
      {!detail ? (
        <p role="status">Loading job details…</p>
      ) : (
        <>
          {detail.errors?.map((error) => (
            <p role="status" key={error}>
              {error}
            </p>
          ))}
          <Timeline job={job} detail={detail} />
          <ChangedFiles files={detail.files} />
          <PublicationPanel
            publication={details[job.id]?.publication ?? detail.publication}
          />
        </>
      )}
      <Json value={{ job, ...detail }} />
    </Modal>
  );
}
