// Optional isolated development database. Hosted operation never runs this script.
import EmbeddedPostgres from "embedded-postgres";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import pg from "pg";
import { applyMigrations } from "./migrations";
async function main() {
  const dir = resolve(".local-pg-conduit"),
    port = 54433;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let password: string;
  try {
    password = await readFile(join(dir, "password"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    password = randomBytes(32).toString("hex");
    await writeFile(join(dir, "password"), password, {
      mode: 0o600,
      flag: "wx",
    });
  }
  const occupied = await new Promise<boolean>((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      e.code === "ECONNREFUSED" ? done(false) : reject(e);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(Error("Port check timed out"));
    });
  });
  const expected = `ADMIN_DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/postgres\nDATABASE_SSL=false\n`;
  if (occupied) {
    const existing = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password,
      database: "postgres",
      connectionTimeoutMillis: 3000,
    });
    try {
      await existing.connect();
      const {
        rows: [state],
      } = await existing.query(
        "SELECT current_setting('data_directory') AS directory, to_regnamespace('conduit_meta') IS NOT NULL AS ready",
      );
      if (
        resolve(state.directory) !== join(dir, "data") ||
        !state.ready ||
        (await readFile(".env.admin.local", "utf8")) !== expected
      )
        throw Error("Database mismatch");
    } catch {
      throw Error(
        "Port 54433 is occupied but could not be verified as the Conduit development database. No existing database was changed.",
      );
    } finally {
      await existing.end();
    }
    console.log(
      "Conduit development database is already running on 127.0.0.1:54433.",
    );
    return;
  }
  try {
    const previous = await readFile(".env.admin.local", "utf8");
    if (previous !== expected)
      throw Error(
        "A different .env.admin.local already exists; refusing to overwrite it",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const diagnostics: string[] = [];
  const capture = (value: unknown) => {
    diagnostics.push(String(value).replaceAll(password, "[redacted]"));
    if (diagnostics.length > 10) diagnostics.shift();
  };
  const postgres = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    port,
    user: "postgres",
    password,
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
      await applyMigrations(db);
    } finally {
      await db.end();
    }
    try {
      await writeFile(".env.admin.local", expected, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    console.log(
      "Conduit development PostgreSQL ready on 127.0.0.1:54433. Admin configuration saved privately. Run npm run db:runtime once, then configure .env.local from its output file. Keep this terminal open.",
    );
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  } catch {
    throw Error(
      `Local PostgreSQL setup failed. ${diagnostics.join("").trim()}`,
    );
  } finally {
    if (started) await postgres.stop();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Local database startup failed",
  );
  process.exitCode = 1;
});
