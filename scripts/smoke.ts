// Real API probe: works on loopback for local tests and HTTPS for Vercel.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { apiOrigin } from "../worker/client";
async function main() {
  const origin = apiOrigin(
    process.env.CONDUIT_API_URL ??
      process.env.ORCHESTRATOR_URL ??
      "http://127.0.0.1:3000",
  );
  if (!process.env.SUBMITTER_KEY_FILE)
    throw Error("SUBMITTER_KEY_FILE required");
  const credential = JSON.parse(
    await readFile(process.env.SUBMITTER_KEY_FILE, "utf8"),
  );
  if (
    credential.role !== "submitter" ||
    !/^cnd_live_[A-Za-z0-9_-]{43}$/.test(credential.token)
  )
    throw Error("Submitter credential required");
  const requestId = z
    .string()
    .uuid()
    .parse(process.env.REQUEST_ID ?? randomUUID());
  await mkdir(".secrets", { recursive: true, mode: 0o700 });
  const receipt = resolve(".secrets", `smoke-${requestId}.json`);
  let prior:
    { request_id: string; job_id?: string; origin: string } | undefined;
  try {
    prior = JSON.parse(await readFile(receipt, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (prior && prior.origin !== origin.origin)
    throw Error("Request ID belongs to another API origin");
  const save = async (job_id?: string) =>
    writeFile(
      receipt,
      JSON.stringify({ request_id: requestId, job_id, origin: origin.origin }),
      { mode: 0o600 },
    );
  // Persist the create ID before the network call, so an ambiguous response can be retried.
  if (!prior) await save();
  console.log(JSON.stringify({ request_id: requestId, receipt }));
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return response.json();
  };
  const { job } = await request("/api/jobs", {
    title: "Conduit connectivity probe",
    description: "Verify submission and result retrieval",
    task: "simulate-development",
  });
  await save(job.id);
  const duplicate = await request("/api/jobs", {
    title: "Conduit connectivity probe",
    description: "Verify submission and result retrieval",
    task: "simulate-development",
  });
  if (duplicate.job.id !== job.id) throw Error("Idempotency check failed");
  for (let i = 0; i < 30; i++) {
    const { job: current } = await request(`/api/jobs/${job.id}`);
    if (current.status === "failed")
      throw Error("Simulated job reported failure");
    if (current.status === "completed") {
      if (current.result?.simulated !== true)
        throw Error("Unexpected simulation result");
      console.log(
        JSON.stringify({
          job_id: current.id,
          status: current.status,
          worker_id: current.worker_id,
          attempt_count: current.attempt_count,
          completed_at: current.completed_at,
          result: current.result,
        }),
      );
      return;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw Error("Timed out waiting for worker; keep the request ID for retry");
}
main().catch((error) => {
  console.error(
    /^HTTP \d+$/.test(error?.message)
      ? error.message
      : "Smoke probe failed. Check the API, key file, and worker. Retain the printed request ID to retry safely.",
  );
  process.exitCode = 1;
});
