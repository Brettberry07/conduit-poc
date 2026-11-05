import { parseArgs } from "node:util";
import { adminDatabase } from "./admin";
import { applyMigrations } from "./migrations";
async function main() {
  const { values } = parseArgs({
    options: {
      "project-ref": { type: "string" },
      local: { type: "boolean" },
      "adopt-legacy": { type: "boolean" },
    },
  });
  const db = adminDatabase();
  try {
    const url = new URL(process.env.ADMIN_DATABASE_URL!);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (local && !values.local) throw Error("Local migration requires --local");
    if (!local) {
      const ref = values["project-ref"];
      if (
        !ref ||
        !/^[a-z0-9]{20}$/.test(ref) ||
        !(
          url.hostname === `db.${ref}.supabase.co` ||
          (url.hostname.endsWith(".pooler.supabase.com") &&
            decodeURIComponent(url.username) === `postgres.${ref}`)
        )
      )
        throw Error(
          "Hosted migration requires --project-ref matching the dedicated Supabase project connection",
        );
      if (values.local) throw Error("--local cannot target a hosted database");
    }
    const client = await db.connect();
    try {
      const files = await applyMigrations(
        client as unknown as import("pg").Client,
        values["adopt-legacy"],
      );
      console.log(JSON.stringify({ applied: files }));
    } finally {
      client.release();
    }
  } finally {
    await db.end();
  }
}
main().catch(() => {
  console.error(
    "Migration failed. Check target, admin permissions, migration history and --local / --project-ref options. No credentials were printed.",
  );
  process.exitCode = 1;
});
