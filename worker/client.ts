import { ApiError, type Call } from "./runner";
export function apiOrigin(value: string) {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw Error("Invalid API origin");
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error("Use a plain API origin without credentials or a path");
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    )
  )
    throw Error("HTTPS required except loopback");
  return base;
}
export function workerClient(base: URL, token: string): Call {
  return async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response.json();
  };
}
