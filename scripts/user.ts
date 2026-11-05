import { parseArgs } from "node:util";
import { z } from "zod";
import { adminDatabase } from "./admin";
import { createKeyOptions } from "./key-options";
const usage =
  "Usage: npm exec -- tsx scripts/user.ts link --auth-user-id UUID --principal PRINCIPAL | list | unlink --auth-user-id UUID";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "auth-user-id": { type: "string" },
      principal: { type: "string" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["link", "list", "unlink"].includes(command))
    throw Error(usage);
  if (
    (command === "list" && Object.keys(values).length) ||
    (command === "unlink" && values.principal)
  )
    throw Error(usage);
  const id =
    command === "list"
      ? undefined
      : z.string().uuid().parse(values["auth-user-id"]);
  const principal =
    command === "link"
      ? createKeyOptions.shape.principal.parse(values.principal)
      : undefined;
  const db = adminDatabase();
  try {
    if (command === "list") {
      console.log(
        JSON.stringify(
          (
            await db.query(
              "SELECT auth_user_id,principal,email,created_at FROM orchestrator.auth_users ORDER BY created_at DESC",
            )
          ).rows,
          null,
          2,
        ),
      );
    } else if (command === "link") {
      const result = await db.query(
        "INSERT INTO orchestrator.auth_users(auth_user_id,principal) VALUES($1,$2) ON CONFLICT(auth_user_id) DO NOTHING RETURNING auth_user_id",
        [id, principal],
      );
      if (!result.rowCount)
        throw Error(
          "Auth user ID already linked; unlink explicitly before changing it",
        );
      console.log("Account linked");
    } else {
      const result = await db.query(
        "DELETE FROM orchestrator.auth_users WHERE auth_user_id=$1 RETURNING auth_user_id",
        [id],
      );
      if (!result.rowCount) throw Error("Auth user ID not found");
      console.log("Account unlinked");
    }
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof z.ZodError
      ? "Invalid user options. " + usage
      : error?.code
        ? "User administration failed; verify the admin connection and permissions"
        : error instanceof Error
          ? error.message
          : "User administration failed",
  );
  process.exitCode = 1;
});
