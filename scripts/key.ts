import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { database } from "../src/lib/db";
import { hashKey } from "../src/lib/api";
const [command, role, principal, hoursText = "24"] = process.argv.slice(2);
if (
  !["create", "revoke"].includes(command) ||
  !["submitter", "worker"].includes(role) ||
  !principal ||
  !/^[a-zA-Z0-9_-]{1,80}$/.test(principal)
)
  throw Error(
    "Usage: npm run key -- create|revoke submitter|worker principal [hours=24]",
  );
const db = database() as pg.Pool;
try {
  if (command === "revoke") {
    await db.query(
      `UPDATE orchestrator.api_keys SET revoked_at=clock_timestamp() WHERE role=$1 AND principal=$2`,
      [role, principal],
    );
    console.log("Credentials for principal revoked.");
  } else {
    const hours = Number(hoursText);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168)
      throw Error("Hours must be >0 and <=168");
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + hours * 3600000).toISOString();
    await mkdir(".secrets", { recursive: true, mode: 0o700 });
    const path = `.secrets/${role}-${principal}-${Date.now()}.json`;
    await writeFile(
      path,
      JSON.stringify({ token, principal, role, expires_at: expires }, null, 2) +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
    try {
      await db.query(
        `INSERT INTO orchestrator.api_keys(key_hash,principal,role,expires_at) VALUES($1,$2,$3,$4)`,
        [hashKey(token), principal, role, expires],
      );
    } catch {
      throw Error(
        "Credential registration failed; generated file is not usable.",
      );
    }
    console.log(
      `Credential written to ${path} (expires ${expires}). Token was not printed.`,
    );
  }
} finally {
  await db.end();
}
