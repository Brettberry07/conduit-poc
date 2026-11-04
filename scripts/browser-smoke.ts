// Run against your already-started local API and worker. Keys never enter output.
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const file = process.env.SUBMITTER_KEY_FILE;
if (!file) throw Error("SUBMITTER_KEY_FILE required");
const { token } = JSON.parse(await readFile(file, "utf8"));
const origin = "http://127.0.0.1:3000";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  console.log("smoke: opening");
  await page.goto(origin);
  await page.getByLabel("Submitter API key").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "Workers", exact: true }).waitFor();
  const title = `Browser smoke ${Date.now()}`;
  await page.getByLabel("Job title").fill(title);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Queue job", exact: true }).click();
  console.log("smoke: submitted");
  const r = await response;
  assert.equal(r.status(), 201);
  const listing = await fetch(`${origin}/api/jobs`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const job = (await listing.json()).jobs.find(
    (j: { title: string }) => j.title === title,
  );
  assert.ok(job);
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  console.log("smoke: waiting for card");
  await card.waitFor();
  await card.getByText("Details and result").click();
  console.log("smoke: waiting for completion");
  await page.waitForFunction(
    (title) => {
      const card = Array.from(document.querySelectorAll("article")).find(
        (a) => a.querySelector("h3")?.textContent === title,
      );
      return card
        ?.closest("section")
        ?.querySelector("h2")
        ?.textContent?.startsWith("completed");
    },
    title,
    { timeout: 30000 },
  );
  if ((await card.locator("details").getAttribute("open")) === null) {
    await card.getByText("Details and result").click();
  }
  assert.match(await card.locator("pre").innerText(), /"simulated": true/);
  console.log("smoke: reading status");
  const status = await fetch(`${origin}/api/jobs/${job.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(status.status, 200);
  const data = await status.json();
  assert.equal(data.job.status, "completed");
  assert.equal(data.job.result.simulated, true);
  assert.equal(data.job.attempt_count, 1);
  assert.equal(data.job.claim_token, undefined);
  console.log("smoke: screenshot");
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({
    path: "output/playwright/dashboard.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: "passed",
      job_id: job.id,
      status: data.job.status,
      result: data.job.result,
      screenshot: "output/playwright/dashboard.png",
    }),
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
} finally {
  await browser.close();
}
