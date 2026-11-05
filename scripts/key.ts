import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { adminDatabase } from "./admin";
import { credentialScopes, generateKey } from "../src/lib/keys";
import { createKeyOptions, credentialRoles } from "./key-options";
const usage =
  "Usage: npm run key -- create --type instinct|worker|viewer --principal ID --name NAME [--days 30] [--out .secrets/key.json] | list | revoke KEY_UUID";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      type: { type: "string" },
      principal: { type: "string" },
      name: { type: "string" },
      days: { type: "string", default: "30" },
      out: { type: "string" },
    },
  });
  const command = positionals[0];
  if (!["create", "list", "revoke"].includes(command)) throw Error(usage);
  let input: z.infer<typeof createKeyOptions> | undefined;
  if (command === "create") {
    input = createKeyOptions.parse(values);
    if (!values.out && !process.stdout.isTTY)
      throw Error(
        "Use --out .secrets/key.json for noninteractive generation; plaintext is displayed only in an interactive terminal",
      );
    if (positionals.length !== 1) throw Error(usage);
  } else if (command === "revoke") {
    z.string().uuid().parse(positionals[1]);
    if (positionals.length !== 2) throw Error(usage);
  } else if (positionals.length !== 1) throw Error(usage);
  const db = adminDatabase();
  try {
    if (command === "list") {
      const { rows } = await db.query(
        `SELECT id,name,key_prefix,principal,role,scopes,created_at,expires_at,revoked_at,last_used_at FROM orchestrator.api_keys ORDER BY created_at DESC`,
      );
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (command === "revoke") {
      const result = await db.query(
        `UPDATE orchestrator.api_keys SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING id`,
        [positionals[1]],
      );
      if (!result.rowCount) throw Error("Key ID not found");
      console.log(`Revoked key ${result.rows[0].id}`);
      return;
    }
    const { type, principal, name, days } = input!;
    const { token, hash, prefix } = generateKey();
    const {
      rows: [key],
    } = await db.query(
      `INSERT INTO orchestrator.api_keys(key_hash,principal,role,name,key_prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+make_interval(days=>$7)) RETURNING id,expires_at`,
      [
        hash,
        principal,
        credentialRoles[type],
        name,
        prefix,
        [...credentialScopes[type]],
        days,
      ],
    );
    const credential = {
      token,
      id: key.id,
      principal,
      role: credentialRoles[type],
      scopes: credentialScopes[type],
      expires_at: key.expires_at,
    };
    try {
      if (values.out) {
        await mkdir(dirname(values.out), { recursive: true, mode: 0o700 });
        await writeFile(
          values.out,
          JSON.stringify(credential, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        console.log(
          `Key ${key.id} delivered to ${values.out}; expires ${new Date(key.expires_at).toISOString()}. Plaintext was not printed.`,
        );
      } else {
        console.log(
          `Key ID: ${key.id}\nExpires: ${new Date(key.expires_at).toISOString()}\nCopy this credential now; it cannot be retrieved again:\n${token}`,
        );
      }
    } catch {
      await db.query(
        "UPDATE orchestrator.api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
        [key.id],
      );
      throw Error(
        "Credential delivery failed; generated key was revoked. Use a new output path.",
      );
    }
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  // Validation and pg errors can contain input and query parameters. Never serialize them.
  console.error(
    error instanceof z.ZodError
      ? "Invalid key options. " + usage
      : error?.code
        ? "Key administration failed; verify the admin connection and permissions"
        : error instanceof Error
          ? error.message
          : "Key administration failed",
  );
  process.exitCode = 1;
});
