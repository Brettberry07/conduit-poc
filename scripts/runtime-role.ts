import { randomBytes, pbkdf2Sync, createHash, createHmac } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { adminDatabase } from "./admin";
// Send a SCRAM verifier to PostgreSQL rather than putting the plaintext password in SQL/logs.
function scramVerifier(password: string) {
  const salt = randomBytes(16),
    iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}
// Run only by the database administrator. There is deliberately no HTTP equivalent.
async function main() {
  const db = adminDatabase();
  const file = ".secrets/runtime-database.env";
  let reserved = false;
  try {
    await mkdir(".secrets", { recursive: true, mode: 0o700 });
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    reserved = true;
    const password = randomBytes(32).toString("hex");
    const url = new URL(process.env.ADMIN_DATABASE_URL!);
    const username = decodeURIComponent(url.username);
    url.username = username.includes(".")
      ? `conduit_runtime.${username.split(".").slice(1).join(".")}`
      : "conduit_runtime";
    url.password = password;
    if (url.hostname.endsWith(".pooler.supabase.com")) url.port = "6543";
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      const exists = await connection.query(
        "SELECT 1 FROM pg_roles WHERE rolname='conduit_runtime'",
      );
      if (exists.rowCount)
        throw Error(
          "Runtime role already exists; refusing to rotate its password implicitly",
        );
      const {
        rows: [statement],
      } = await connection.query(
        "SELECT format('CREATE ROLE conduit_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', $1::text) AS sql",
        [scramVerifier(password)],
      );
      await connection.query(statement.sql);
      await connection.query("GRANT conduit_api TO conduit_runtime");
      // Role defaults work through transaction pooling; session SET/startup options do not.
      await connection.query(
        "ALTER ROLE conduit_runtime SET statement_timeout='10s'",
      );
      await connection.query(
        "ALTER ROLE conduit_runtime SET lock_timeout='5s'",
      );
      await connection.query(
        "ALTER ROLE conduit_runtime SET idle_in_transaction_session_timeout='15s'",
      );
      await writeFile(
        file,
        `DATABASE_URL="${url.toString()}"\nDATABASE_SSL=${process.env.DATABASE_SSL === "true" ? "true" : "false"}\n`,
        { mode: 0o600 },
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    console.log(
      `Runtime connection written to ${file}; no credential was printed. Add any required CA certificate separately.`,
    );
    reserved = false;
  } finally {
    if (reserved) await rm(file, { force: true });
    await db.end();
  }
}
main().catch(() => {
  console.error(
    "Runtime provisioning failed. Check admin credentials, applied migrations, existing conduit_runtime role, and whether .secrets/runtime-database.env already exists. No existing role/password was changed.",
  );
  process.exitCode = 1;
});
