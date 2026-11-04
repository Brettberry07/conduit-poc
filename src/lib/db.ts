import pg from "pg";
import { readFileSync } from "node:fs";
export interface DB {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}
let pool: pg.Pool;
export function database(): DB {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return (pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: true,
            ...(process.env.DATABASE_CA_FILE
              ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") }
              : {}),
          }
        : undefined,
  }));
}
