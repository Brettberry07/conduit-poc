import pg from "pg";
import { readFileSync } from "node:fs";
import { attachDatabasePool } from "@vercel/functions";
export interface DB {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface DBConnection extends DB {
  release(error?: Error | boolean): void;
}
export interface PooledDB extends DB {
  connect(): Promise<DBConnection>;
}
export async function transaction<T>(
  db: DB,
  run: (connection: DBConnection) => Promise<T>,
): Promise<T> {
  const pooled = db as Partial<PooledDB>;
  if (!pooled.connect) throw Error("A pooled database connection is required");
  const connection = await pooled.connect();
  let rollbackError: Error | undefined;
  try {
    await connection.query("BEGIN");
    const result = await run(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch (failure) {
      // Discard a connection whose transaction state could not be cleared.
      rollbackError =
        failure instanceof Error ? failure : new Error("Rollback failed");
    }
    throw error;
  } finally {
    connection.release(rollbackError);
  }
}
// Never include credentials in errors; pg connection strings may contain URL-encoded passwords.
export function poolConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw Error("Invalid database connection configuration");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("PostgreSQL connection URL required");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!local && env.DATABASE_SSL !== "true")
    throw Error("Verified TLS is required for remote database connections");
  // URL sslmode options override pg's ssl object; reject them instead of silently weakening TLS.
  for (const param of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    if (url.searchParams.has(param))
      throw Error(
        "Remove SSL query parameters from database URL; configure DATABASE_SSL and DATABASE_CA_PEM instead",
      );
  return {
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true,
    ssl:
      env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: true,
            ...(env.DATABASE_CA_PEM
              ? { ca: env.DATABASE_CA_PEM }
              : env.DATABASE_CA_FILE
                ? { ca: readFileSync(env.DATABASE_CA_FILE, "utf8") }
                : {}),
          }
        : undefined,
  };
}
let pool: pg.Pool | undefined;
export function database(): DB {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
  if (!pool) {
    pool = new pg.Pool(poolConfig(process.env.DATABASE_URL));
    pool.on("error", () =>
      console.error(JSON.stringify({ event: "database_pool_error" })),
    );
    if (process.env.VERCEL) attachDatabasePool(pool);
  }
  return pool;
}
