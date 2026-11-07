export type Session = {
  access_token: string;
  refresh_token: string;
  user: unknown;
};
export const sessionKey = "conduit.auth.session";
export function authRequest(
  action: "signup" | "password" | "refresh_token" | "logout",
  body: unknown,
  token?: string,
  env = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
) {
  if (!env.url || !env.key) return null;
  return {
    url:
      env.url.replace(/\/$/, "") +
      "/auth/v1/" +
      (action === "signup" || action === "logout"
        ? action
        : "token?grant_type=" + action),
    init: {
      method: "POST",
      headers: {
        apikey: env.key,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}
export async function gotrue(
  action: Parameters<typeof authRequest>[0],
  body: unknown,
  token?: string,
): Promise<Session | null> {
  const request = authRequest(action, body, token);
  if (!request) throw Error("Email authentication is unavailable.");
  const response = await fetch(request.url, {
    ...request.init,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok)
    throw Error(
      "Authentication failed. Check your credentials and email confirmation.",
    );
  if (action === "logout") return null;
  const session = await response.json();
  return validSession(session) ? session : null;
}
export function validSession(value: unknown): value is Session {
  return (
    !!value &&
    typeof value === "object" &&
    "access_token" in value &&
    typeof value.access_token === "string" &&
    "refresh_token" in value &&
    typeof value.refresh_token === "string" &&
    "user" in value
  );
}
// One client per console: coalesce simultaneous polling requests into one refresh.
export function sessionClient(changed: (session: Session | null) => void) {
  let current: Session | null = null;
  let pending: Promise<Session | null> | null = null;
  let generation = 0;
  function save(session: Session | null) {
    current = session;
    generation++;
    try {
      if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
      else localStorage.removeItem(sessionKey);
    } finally {
      changed(session);
    }
  }
  return {
    save,
    restore() {
      try {
        const value = JSON.parse(localStorage.getItem(sessionKey) ?? "null");
        if (validSession(value)) {
          current = value;
          changed(value);
        }
      } catch {
        /* Storage may be unavailable. */
      }
    },
    async logout() {
      const token = current?.access_token;
      try {
        if (token) await gotrue("logout", {}, token);
      } finally {
        save(null);
      }
    },
    async fetch(path: string, init: RequestInit, token: string) {
      const response = await fetch(path, init);
      if (response.status !== 401 || !current) return response;
      if (current.access_token === token) {
        if (!pending) {
          const version = generation;
          pending = gotrue("refresh_token", {
            refresh_token: current.refresh_token,
          })
            .catch(() => null)
            .then((session) => {
              if (generation === version) save(session);
              return session;
            })
            .finally(() => {
              pending = null;
            });
        }
        await pending;
      }
      if (!current) return response;
      const retry = await fetch(path, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${current.access_token}`,
        },
      });
      if (retry.status === 401) save(null);
      return retry;
    },
  };
}

export async function readApi(
  path: string,
  key: string,
  signal: AbortSignal,
  transport: (
    path: string,
    init: RequestInit,
    token: string,
  ) => Promise<Response>,
) {
  if (
    !/^\/api\/(workers|jobs(?:\?[^#]*)?|jobs\/[a-zA-Z0-9-]+\/(executions|changes|publication)|agent\/events\?job_id=[a-fA-F0-9-]{36}&limit=20)$/.test(
      path,
    )
  )
    throw Error("Unsupported read");
  const r = await transport(
    path,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    },
    key,
  );
  if (
    r.status === 403 &&
    (
      await r
        .clone()
        .json()
        .catch(() => null)
    )?.error === "account not linked"
  )
    throw Error("This account isn't linked to any Conduit workspace yet.");
  if (!r.ok)
    throw Error(
      r.status === 401
        ? "Key not recognized. Connect with a valid read-only Instinct key."
        : r.status === 403
          ? "This key needs jobs:read permission."
          : r.status === 404
            ? "Not available for this job"
            : `Service unavailable (${r.status})`,
    );
  return r.json();
}
export async function connectEmail(
  action: "password" | "signup",
  email: string,
  password: string,
  save: (session: Session) => void,
): Promise<string> {
  const session = await gotrue(action, { email, password });
  if (session) {
    save(session);
    return "";
  }
  return "Check your email to confirm your account, then sign in.";
}
