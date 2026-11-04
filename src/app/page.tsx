"use client";
import { useState, useEffect, useCallback } from "react";
type Job = {
  id: string;
  title: string;
  description: string;
  task: string;
  status: string;
  progress: number;
  worker_id: string | null;
  attempt_count: number;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  lease_expires_at: string | null;
};
type Worker = {
  worker_id: string;
  available: boolean;
  busy: boolean;
  last_seen_at: string;
};
export default function Dashboard() {
  const [key, setKey] = useState(""),
    [active, setActive] = useState(""),
    [jobs, setJobs] = useState<Job[]>([]),
    [workers, setWorkers] = useState<Worker[]>([]),
    [error, setError] = useState(""),
    [title, setTitle] = useState(""),
    [task, setTask] = useState("simulate-development"),
    [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const responses = await Promise.all(
        ["/api/jobs", "/api/workers"].map((url) =>
          fetch(url, {
            headers: { Authorization: `Bearer ${active}` },
            cache: "no-store",
          }),
        ),
      );
      if (responses.some((r) => !r.ok))
        throw Error("Unable to load. Check your key and API connection.");
      const [j, w] = await Promise.all(responses.map((r) => r.json()));
      setJobs(j.jobs);
      setWorkers(w.workers);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [active]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${active}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ title, task }),
      });
      if (!r.ok) throw Error("Job submission failed.");
      setTitle("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <main>
      <header>
        <span className="eyebrow">LOCAL QUEUE / SIMULATED EXECUTION</span>
        <h1>Orchestrator POC</h1>
        <p>A small, observable job queue. No Codex or GitHub execution.</p>
      </header>
      {!active ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setActive(key);
            setKey("");
          }}
        >
          <label>
            Submitter API key
            <input
              type="password"
              autoComplete="off"
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button>Connect</button>
          <p>Kept in memory for this tab only.</p>
        </form>
      ) : (
        <>
          <button
            className="secondary"
            onClick={() => {
              setActive("");
              setJobs([]);
              setWorkers([]);
            }}
          >
            Disconnect
          </button>
          <form onSubmit={submit} className="create">
            <label>
              Job title
              <input
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Predefined task
              <select value={task} onChange={(e) => setTask(e.target.value)}>
                <option value="simulate-development">
                  Simulate development
                </option>
                <option value="simulate-failure">Simulate failure</option>
              </select>
            </label>
            <button disabled={pending}>
              {pending ? "Submitting…" : "Queue job"}
            </button>
          </form>
          <section>
            <h2>Workers</h2>
            {workers.length === 0 ? (
              <p>No workers seen yet.</p>
            ) : (
              workers.map((w) => (
                <p key={w.worker_id}>
                  <strong>{w.worker_id}</strong> ·{" "}
                  {!w.available ? "Offline" : w.busy ? "Busy" : "Available"} ·
                  Last seen {new Date(w.last_seen_at).toLocaleString()}
                </p>
              ))
            )}
          </section>
          <p>Showing your latest 100 jobs · refreshes every 3 seconds</p>
          <div className="columns">
            {["queued", "running", "completed", "failed"].map((status) => (
              <section key={status}>
                <h2>
                  {status}{" "}
                  <small>
                    {jobs.filter((j) => j.status === status).length}
                  </small>
                </h2>
                {jobs
                  .filter((j) => j.status === status)
                  .map((j) => (
                    <article key={j.id}>
                      <h3>{j.title}</h3>
                      <p>{j.description}</p>
                      <p>
                        {j.progress}% · attempt {j.attempt_count} ·{" "}
                        {j.worker_id ?? "Unassigned"}
                      </p>
                      <details>
                        <summary>Details and result</summary>
                        <code>{j.id}</code>
                        {[
                          "created_at",
                          "claimed_at",
                          "completed_at",
                          "lease_expires_at",
                        ].map((k) => (
                          <p key={k}>
                            {k.replaceAll("_", " ")}:{" "}
                            {j[k as keyof Job]
                              ? new Date(
                                  j[k as keyof Job] as string,
                                ).toLocaleString()
                              : "—"}
                          </p>
                        ))}
                        <pre>{JSON.stringify(j.result, null, 2)}</pre>
                        {j.error && <p role="alert">{j.error}</p>}
                      </details>
                    </article>
                  ))}
                {!jobs.some((j) => j.status === status) && (
                  <p>No {status} jobs.</p>
                )}
              </section>
            ))}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
