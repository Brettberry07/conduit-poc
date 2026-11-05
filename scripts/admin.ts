import { config } from "dotenv";
import pg from "pg";
import { poolConfig } from "../src/lib/db";
// Deliberately separate from DATABASE_URL: the deployed API never needs this credential.
export function adminDatabase() {
  config({
    path: process.env.CONDUIT_ADMIN_ENV_FILE ?? ".env.admin.local",
    quiet: true,
  });
  if (!process.env.ADMIN_DATABASE_URL)
    throw Error(
      "ADMIN_DATABASE_URL is required in a private admin environment file",
    );
  const pool = new pg.Pool(poolConfig(process.env.ADMIN_DATABASE_URL));
  pool.on("error", () => {
    console.error("Administrator database connection error");
    process.exitCode = 1;
  });
  return pool;
}
