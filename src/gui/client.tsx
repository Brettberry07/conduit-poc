"use client";
import Link from "next/link";
import { authRequest, connectEmail, readApi, sessionClient } from "./auth";
import { usePathname, useRouter } from "next/navigation";
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
  dependencyLabel,
  githubUrl,
  needsYou,
  stale,
  type Job,
  type Worker,
  type Detail,
  type ActivityEvent,
} from "./model";
type Data = {
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
};
const Context = createContext<Data>(null!);
const iconPaths = {
  brand: "M3 12V4h8M3 4l10 8M7 12h6V6",
  board: "M2 3h12v10H2zM6 3v10M10 3v10",
  active: "M1 8h3l2-5 4 10 2-5h3",
  review: "M8 2l6 6-6 6-6-6zM8 5v3M8 11h.01",
  sidebar: "M2 3h12v10H2zM6 3v10",
  connection: "M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  search: "M10.5 10.5L14 14M11 6.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0",
  external: "M9 2h5v5M14 2L7 9M6 3H2v11h11v-4",
  close: "M4 4l8 8M12 4l-8 8",
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
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={sheet ? "sheet" : ""}
      aria-label={label}
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
      setSelected(null);
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
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Job | null>(null),
    [collapsed, setCollapsed] = useState(false),
    [palette, setPalette] = useState(false);
  const pathname = usePathname(),
    router = useRouter();
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
            setSelected(null);
            setUpdated(0);
          }
        }
      } finally {
        busy = false;
        if (!stopped) setLoading(false);
      }
    }
    const visibility = () => {
      if (document.hidden) controller.abort();
      else void poll();
    };
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
    setSelected(null);
    setUpdated(0);
    setError("");
  };
  const needs = needsYou(jobs, workers, details, now),
    counts = [
      jobs.filter((j) => column(j.status) === "Queued").length,
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
                href={`/app/${route}`}
                aria-label={label}
                aria-current={pathname === `/app/${route}` ? "page" : undefined}
              >
                <Icon name={icon} />
                <span className="nav-label">{label}</span>
                <b
                  aria-label={`${counts[i]} ${["queued", "running", "needs you"][i]}`}
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
                  Workspace / {routes.find((r) => pathname.endsWith(r[0]))?.[2]}
                </span>
                <span role="status">
                  {updated
                    ? `Updated ${age(new Date(updated).toISOString(), now)}`
                    : "Loading…"}
                </span>
                <button onClick={() => setPalette(true)}>
                  <Icon name="search" /> Command K
                </button>
              </div>
              {(error || (updated && now - updated > 15000)) && (
                <p className="banner" role="alert">
                  {error ||
                    "Updates are stale. Polling pauses while this tab is hidden."}{" "}
                  Last successful data is retained.
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
                  router.push("/app/board");
                  setPalette(false);
                }
              }}
            />
            {routes.map(([route, icon, label]) => (
              <button
                className="command"
                key={route}
                onClick={() => {
                  router.push(`/app/${route}`);
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
    <pre>
      {value == null
        ? "Not reported"
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2)}
    </pre>
  );
}
function JobCard({ job }: { job: Job }) {
  const c = useContext(Context);
  return (
    <article className={`job ${job.status}`}>
      <button className="job-open" onClick={() => c.select(job)}>
        <span className="job-id">
          {job.id.slice(0, 8)} · {job.status}
        </span>
        <h3>{job.title}</h3>
        <p className="mono">
          {job.project ?? job.project_id ?? "No project"} /{" "}
          {job.base_branch ?? "No branch"}
        </p>
        <span>
          {job.phase ?? "Phase not reported"} · {job.progress}%
        </span>
        <progress max={100} value={job.progress} aria-label="Job progress" />
        <small>
          Attempt {job.attempt_count} · {job.worker_id ?? "Unassigned"}
        </small>
        {job.status === "waiting_dependencies" && (
          <span className="waiting">{dependencyLabel(job)}</span>
        )}
        {job.error && <p className="failure">{job.error}</p>}
        <small>
          {job.root_job_id && job.root_job_id !== job.id
            ? `Revision of ${job.root_job_id}`
            : "Root job"}
        </small>
        <small>
          Created {age(job.created_at, c.now)}
          <br />
          Claimed {age(job.claimed_at, c.now)}
          <br />
          Completed {age(job.completed_at, c.now)}
        </small>
      </button>
      <Github url={c.details[job.id]?.publication?.pull_request?.url} />
    </article>
  );
}
function Checks({ result }: { result?: Record<string, unknown> | null }) {
  const checks = result?.checks;
  return Array.isArray(checks) ? (
    <ul>
      {checks.map((v, i) => {
        const x = (v && typeof v === "object" ? v : {}) as Record<
          string,
          unknown
        >;
        return (
          <li key={i}>
            {String(x.name ?? x.command ?? "Check")} · exit{" "}
            {String(x.exit_code ?? "not reported")} · timed out:{" "}
            {String(x.timed_out ?? "not reported")}
          </li>
        );
      })}
    </ul>
  ) : null;
}
function Timeline({ job, detail }: { job: Job; detail?: Detail }) {
  return (
    <div className="timeline">
      <h4>Execution details</h4>
      <ol>
        {job.claimed_at && <li>Claimed · {age(job.claimed_at)}</li>}
        <li>Current phase: {job.phase ?? "not reported"}</li>
        {detail?.executions?.map((e) => (
          <li key={e.attempt}>
            Attempt {e.attempt} · {e.status} · {age(e.started_at)}
            {e.error && <p>{e.error}</p>}
            <Checks result={e.result} />
          </li>
        ))}
        <li>
          Publication:{" "}
          {detail?.publication?.publication_state ?? "not reported"}
        </li>
      </ol>
      <Checks result={job.result} />
      {detail?.errors?.map((e) => (
        <p className="muted" key={e}>
          {e}
        </p>
      ))}
    </div>
  );
}
export function Screen({ view }: { view: string }) {
  const c = useContext(Context),
    needs = needsYou(c.jobs, c.workers, c.details, c.now);
  return (
    <section className="screen">
      <header>
        <p className="eyebrow">CONDUIT / READ ONLY</p>
        <h1>
          {view === "board"
            ? "A place for every job."
            : view === "active"
              ? "Work in motion."
              : "Your attention, here."}
        </h1>
        <p className="muted">
          {view === "board"
            ? "From the queue to a published result."
            : view === "active"
              ? "Worker status and reported activity. No live Codex stream."
              : "Decisions and recovery signals from reported data. No actions run here."}
        </p>
      </header>
      {c.loading && !c.updated ? (
        <div className="skeleton" role="status">
          Loading workspace…
        </div>
      ) : !c.updated ? (
        <p className="empty">
          Workspace unavailable. Reads retry every 3 seconds while visible.
        </p>
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
          <p className="muted">
            Latest {c.jobs.length} jobs (up to 100). Counts and review signals
            cover this window.
          </p>
          <div className="board">
            {columns
              .filter(
                (name) =>
                  name !== "Unknown status" ||
                  c.jobs.some((j) => column(j.status) === name),
              )
              .map((name) => {
                const list = c.jobs.filter(
                  (j) =>
                    column(j.status) === name &&
                    `${j.title} ${j.id} ${j.status}`
                      .toLowerCase()
                      .includes(c.search.toLowerCase()),
                );
                return (
                  <section className="lane" data-status={name} key={name}>
                    <h2>
                      <span
                        className={`dot ${name === "Completed" ? "green" : name === "Failed / blocked" ? "red" : ""}`}
                      />
                      {name}
                      <span className="count">{list.length}</span>
                    </h2>
                    {list.map((j) => (
                      <JobCard key={j.id} job={j} />
                    ))}
                    {!list.length && <p className="empty">No jobs here</p>}
                  </section>
                );
              })}
          </div>
        </>
      ) : view === "active" ? (
        <div className="workers">
          {!c.workers.length && (
            <p className="empty">
              No workers reported. Queued jobs need an available worker.
            </p>
          )}
          {c.workers.map((w) => {
            const list = c.jobs.filter(
                (j) => j.status === "running" && j.worker_id === w.worker_id,
              ),
              offline = !w.available || stale(w, c.now);
            return (
              <section className="worker" key={w.worker_id}>
                <h2 className="mono">{w.worker_id}</h2>
                <p className={offline ? "failure" : "healthy"}>
                  {offline ? "Offline / stale" : "Available"} ·{" "}
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
            <p className="empty">
              Nothing needs you in the loaded data.
              {c.error
                ? " Some data is unavailable; see the banner above."
                : " You’re all caught up."}
            </p>
          )}
          {needs.map((n) => (
            <article key={n.id} className={`need severity-${n.severity}`}>
              <span className="pill">
                {["High", "Attention", "Review"][n.severity]}
              </span>
              <h2>{n.why}</h2>
              {n.job && (
                <p>
                  {n.job.title} · <code>{n.job.id}</code>
                </p>
              )}
              <p className="muted">{age(n.date, c.now)}</p>
              <Github url={n.url} />
              {n.command && (
                <>
                  <p>Operator inspection command (copyable text only)</p>
                  <pre tabIndex={0}>{n.command}</pre>
                </>
              )}
            </article>
          ))}
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
                <time dateTime={event.occurred_at}>
                  {new Date(event.occurred_at).toLocaleString()}
                </time>
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
      <Json value={job.instructions ?? job.description} />
      <h2>Acceptance criteria</h2>
      <Json value={job.acceptance_criteria} />
      <h2>Result summary & verification</h2>
      <Json value={job.result} />
      <h2>Error</h2>
      <Json value={job.error} />
      {!detail ? (
        <p className="skeleton">Loading job details…</p>
      ) : (
        <>
          <Timeline job={job} detail={detail} />
          <h2>Executions</h2>
          <Json value={detail.executions} />
          <h2>Changed files</h2>
          <Json value={detail.files} />
          <p className="muted">
            Latest attempt; up to 100 files reported by this endpoint.
          </p>
          <h2>Publication</h2>
          <Github url={detail.publication?.pull_request?.url} />
          <Json value={detail.publication} />
        </>
      )}
    </Modal>
  );
}
