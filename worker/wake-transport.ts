import { readFile, writeFile, rename, stat } from "node:fs/promises";
export type WakeConfig = {
  url: string;
  publishableKey: string;
  topic: string;
  sessionFile: string;
};
export async function readWakeConfig(): Promise<WakeConfig> {
  const path = process.env.CONDUIT_WAKE_CONFIG_FILE;
  if (!path) throw Error("Wake config file required");
  const c = JSON.parse(await readFile(path, "utf8"));
  const u = new URL(c.url);
  if (
    u.protocol !== "https:" ||
    !u.hostname.endsWith(".supabase.co") ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Invalid Supabase origin");
  if (
    c.topic !== "conduit:pool:shared" ||
    typeof c.publishableKey !== "string" ||
    !c.publishableKey.startsWith("sb_publishable_") ||
    typeof c.sessionFile !== "string"
  )
    throw Error("Invalid wake config");
  return c;
}
export function isWakeHint(x: unknown): boolean {
  return (
    !!x &&
    typeof x === "object" &&
    Object.keys(x).every((k) => k === "v" || k === "id") &&
    (!("id" in x) ||
      (typeof (x as { id?: unknown }).id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          (x as { id: string }).id,
        ))) &&
    (x as { v?: unknown }).v === 1
  );
}
type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};
export class SessionCache {
  private pending?: Promise<string>;
  constructor(
    private session: Session,
    private refresh: (s: Session) => Promise<Session>,
    private now = () => Date.now(),
  ) {}
  async token(): Promise<string> {
    if (this.session.expires_at * 1000 - this.now() > 60_000)
      return this.session.access_token;
    return (this.pending ??= (async () => {
      try {
        this.session = await this.refresh(this.session);
        if (this.session.expires_at * 1000 - this.now() <= 60_000)
          throw Error("Invalid session expiry");
        return this.session.access_token;
      } finally {
        this.pending = undefined;
      }
    })());
  }
}
export async function startWakeTransport(
  c: WakeConfig,
  hint: () => void,
  fatal: () => void,
  deps: { Socket?: typeof WebSocket; fetcher?: typeof fetch } = {},
) {
  const Socket = deps.Socket ?? WebSocket;
  const fetcher = deps.fetcher ?? fetch;
  if ((await stat(c.sessionFile)).mode & 0o077)
    throw Error("Wake session must be private (0600)");
  const session = JSON.parse(await readFile(c.sessionFile, "utf8")) as Session;
  if (
    typeof session.access_token !== "string" ||
    typeof session.refresh_token !== "string" ||
    !Number.isFinite(session.expires_at)
  )
    throw Error("Invalid wake session");
  let stopped = false;
  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let ref = 0;
  let joined = false;
  let lastReply = Date.now();
  let connecting = false;
  const cache = new SessionCache(session, async (s) => {
    const r = await fetcher(
      new URL("/auth/v1/token?grant_type=refresh_token", c.url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          apikey: c.publishableKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      },
    );
    if ([400, 401, 403].includes(r.status)) {
      stopped = true;
      fatal();
      throw Error("Wake session rejected");
    }
    if (!r.ok) throw Error("Wake refresh failed");
    const next = (await r.json()) as Session;
    if (
      typeof next.access_token !== "string" ||
      typeof next.refresh_token !== "string" ||
      !Number.isFinite(next.expires_at) ||
      next.expires_at * 1000 - Date.now() <= 60_000
    )
      throw Error("Invalid refreshed session");
    // Supabase rotates refresh tokens. Persist before using the new session.
    try {
      await writeFile(c.sessionFile + ".tmp", JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(c.sessionFile + ".tmp", c.sessionFile);
    } catch {
      stopped = true;
      fatal();
      throw Error("Cannot persist rotated wake session; recovery required");
    }
    return next;
  });
  const send = (
    event: string,
    payload: unknown,
    topic = "realtime:" + c.topic,
  ) =>
    ws?.readyState === Socket.OPEN &&
    ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  const connect = async () => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      const token = await cache.token();
      if (stopped) return;
      const u = new URL("/realtime/v1/websocket", c.url);
      u.protocol = "wss:";
      u.searchParams.set("apikey", c.publishableKey);
      u.searchParams.set("vsn", "1.0.0");
      ws = new Socket(u);
      const socket = ws;
      let currentToken = token;
      handshake = setTimeout(() => socket.close(), 15_000);
      joined = false;
      ws.onopen = () => {
        if (stopped || ws !== socket) {
          socket.close();
          return;
        }
        lastReply = Date.now();
        send("phx_join", {
          config: {
            private: true,
            broadcast: { self: false, ack: false },
            presence: { enabled: false },
          },
          access_token: token,
        });
        heartbeat = setInterval(() => {
          if (Date.now() - lastReply > 60_000) {
            ws?.close();
            return;
          }
          void cache
            .token()
            .then((t) => {
              if (
                !stopped &&
                ws === socket &&
                socket.readyState === Socket.OPEN
              ) {
                if (t !== currentToken) {
                  send("access_token", { access_token: t });
                  currentToken = t;
                }
                send("heartbeat", {}, "phoenix");
              }
            })
            .catch(() => ws?.close());
        }, 25_000);
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data.length > 4096) return;
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!m || typeof m !== "object") return;
        if (m.event === "phx_reply") {
          lastReply = Date.now();
          if (m.topic === "realtime:" + c.topic && !joined) {
            if (m.payload?.status !== "ok") {
              // A cold hosted Realtime service can report this before its
              // message partitions exist. Only this known readiness failure
              // uses bounded reconnect; auth and unknown denials stay fatal.
              const reason = m.payload?.response?.reason;
              if (
                m.payload?.status === "error" &&
                typeof reason === "string" &&
                reason.startsWith("MissingPartition: ")
              ) {
                ws?.close();
                return;
              }
              stopped = true;
              fatal();
              ws?.close();
              return;
            }
            if (handshake) clearTimeout(handshake);
            joined = true;
            failures = 0;
            hint();
          }
        }
        if (m.topic !== "realtime:" + c.topic) return;
        if (
          m.event === "broadcast" &&
          m.payload?.event === "work_available" &&
          isWakeHint(m.payload.payload)
        )
          hint();
        if (
          ["phx_error", "phx_close"].includes(m.event) ||
          (m.event === "system" && m.payload?.status === "error")
        )
          ws?.close();
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        if (handshake) clearTimeout(handshake);
        if (heartbeat) clearInterval(heartbeat);
        if (!stopped)
          retry = setTimeout(
            () => void connect(),
            Math.min(300_000, 1000 * 2 ** Math.min(++failures, 9)) +
              Math.random() * 1000,
          );
      };
    } catch {
      if (!stopped)
        retry = setTimeout(
          () => void connect(),
          Math.min(300_000, 1000 * 2 ** Math.min(++failures, 9)),
        );
    } finally {
      connecting = false;
    }
  };
  void connect();
  return {
    close() {
      stopped = true;
      if (handshake) clearTimeout(handshake);
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
    },
  };
}
