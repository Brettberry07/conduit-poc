// Optional development-only PostgreSQL fallback when Docker/Supabase local is unavailable.
import EmbeddedPostgres from "embedded-postgres";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import pg from "pg";
async function main() {
  const dir = resolve(".local-pg");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let password: string;
  try {
    password = await readFile(join(dir, "password"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    password = randomBytes(32).toString("hex");
    await writeFile(join(dir, "password"), password, {
      mode: 0o600,
      flag: "wx",
    });
  }
  const port = 54432;
  const occupied = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Timed out checking local database port"));
    });
  });
  if (occupied) {
    const existing = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password,
      database: "postgres",
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    try {
      await existing.connect();
      const {
        rows: [state],
      } = await existing.query(
        "SELECT current_setting('data_directory') AS directory, to_regnamespace('orchestrator') IS NOT NULL AS ready",
      );
      const expected = `DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/postgres\n`;
      if (
        resolve(state.directory) !== join(dir, "data") ||
        !state.ready ||
        (await readFile(".env.local", "utf8")) !== expected
      ) {
        throw new Error(
          "Existing database or environment does not match this POC",
        );
      }
    } catch {
      throw new Error(
        `Port ${port} is already in use, but it could not be verified as this POC database. No database was changed. Check the existing process and .env.local.`,
      );
    } finally {
      await existing.end();
    }
    console.log(
      `This POC database is already running on 127.0.0.1:${port}. No second instance was started. Continue with the API/dashboard or HTTPS tunnel steps.`,
    );
    return;
  }
  const diagnostics: string[] = [];
  const capture = (value: unknown) => {
    const message = (
      value instanceof Error ? value.message : String(value)
    ).replaceAll(password, "[redacted]");
    diagnostics.push(message);
    if (diagnostics.length > 10) diagnostics.shift();
  };
  const postgres = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "postgres",
    password,
    port,
    persistent: true,
    autoRehydrateSymlinks: true,
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: capture,
    onError: capture,
  });
  let started = false;
  try {
    try {
      await readFile(join(dir, "data", "PG_VERSION"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await postgres.initialise();
    }
    await postgres.start();
    started = true;
    const db = postgres.getPgClient();
    await db.connect();
    try {
      const files = (await readdir("supabase/migrations")).sort();
      const sql = (
        await Promise.all(
          files.map((f) => readFile(join("supabase/migrations", f), "utf8")),
        )
      ).join("\n");
      const hash = createHash("sha256").update(sql).digest("hex");
      const exists = (
        await db.query("SELECT to_regnamespace('orchestrator') AS schema")
      ).rows[0].schema;
      if (!exists) {
        await db.query("BEGIN");
        try {
          await db.query(sql);
          await db.query("COMMIT");
        } catch (e) {
          await db.query("ROLLBACK");
          throw e;
        }
        await writeFile(join(dir, "migration-hash"), hash);
      } else if ((await readFile(join(dir, "migration-hash"), "utf8")) !== hash)
        throw Error(
          "Local migration changed. Use a new isolated local database; refusing to overwrite existing data.",
        );
    } finally {
      await db.end();
    }
    const expected = `DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/postgres\n`;
    try {
      await writeFile(".env.local", expected, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if ((await readFile(".env.local", "utf8")) !== expected)
        throw Error(
          ".env.local already points elsewhere. Refusing to change it. Use the documented Supabase setup or move that file yourself.",
        );
    }
    console.log(
      "Isolated local PostgreSQL ready on 127.0.0.1:54432. .env.local configured; no credentials printed. Keep this process running.",
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } catch (error) {
    const details = diagnostics.join("").trim();
    throw new Error(
      `${error instanceof Error ? error.message : "PostgreSQL failed to start"}${details ? "\n" + details : ""}`,
    );
  } finally {
    if (started) await postgres.stop();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Local database startup failed",
  );
  process.exitCode = 1;
});
