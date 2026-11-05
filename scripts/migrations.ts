import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type pg from "pg";
export async function applyMigrations(db: pg.Client, adoptLegacy = false) {
  // One pinned connection/transaction: safe with session/direct admin connections.
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(19273645)");
    await db.query(`CREATE SCHEMA IF NOT EXISTS conduit_meta; REVOKE ALL ON SCHEMA conduit_meta FROM PUBLIC;
   CREATE TABLE IF NOT EXISTS conduit_meta.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
   ALTER TABLE conduit_meta.schema_migrations ENABLE ROW LEVEL SECURITY; REVOKE ALL ON conduit_meta.schema_migrations FROM PUBLIC;`);
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied = (
      await db.query("SELECT name,checksum FROM conduit_meta.schema_migrations")
    ).rows;
    const exists = (
      await db.query("SELECT to_regnamespace('orchestrator') AS schema")
    ).rows[0].schema;
    if (exists && !applied.length && !adoptLegacy)
      throw Error(
        "Existing untracked schema. Use --adopt-legacy only for the original POC schema after reviewing it.",
      );
    const changed: string[] = [];
    for (const [i, name] of files.entries()) {
      const sql = await readFile(join("supabase/migrations", name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = applied.find((m) => m.name === name);
      if (old) {
        if (old.checksum !== checksum)
          throw Error(`Applied migration was modified: ${name}`);
        continue;
      }
      if (!(exists && !applied.length && adoptLegacy && i === 0))
        await db.query(sql);
      await db.query(
        "INSERT INTO conduit_meta.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      changed.push(name);
    }
    await db.query("COMMIT");
    return changed;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
