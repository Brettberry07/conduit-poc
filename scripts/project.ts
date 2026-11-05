import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { adminDatabase } from "./admin";
import { branchSchema, projectColumns } from "../src/lib/development";
import { GitHub, type Project } from "../worker/development/github";
import {
  localProjectSchema,
  initializeRepository,
  storage,
  type LocalProject,
} from "../worker/development/git";
const usage =
  "npm run project -- add --config /absolute/project-registration.json | list | inspect PROJECT_UUID | disable PROJECT_UUID";
const { project_id: _projectId, ...localShape } = localProjectSchema.shape;
export const registrationSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(120),
    repository_owner: z.string().regex(/^[A-Za-z0-9-]+$/),
    repository_name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    default_branch: branchSchema,
    allowed_base_branches: z.array(branchSchema).min(1).max(10),
    local: z.object(localShape).strict(),
  })
  .strict();
export async function validateRegistration(raw: unknown, github: GitHub) {
  const input = registrationSchema.parse(raw),
    id = input.id ?? randomUUID();
  if (!input.allowed_base_branches.includes(input.default_branch))
    throw Error("Default branch must be approved");
  const project: Project = {
    id,
    name: input.name,
    repository_owner: input.repository_owner,
    repository_name: input.repository_name,
    repository_url: `https://github.com/${input.repository_owner}/${input.repository_name}.git`,
    default_branch: input.default_branch,
    allowed_base_branches: input.allowed_base_branches,
    enabled: true,
  };
  const local = localProjectSchema.parse({ ...input.local, project_id: id });
  await storage(local);
  for (const base of project.allowed_base_branches)
    await github.safety(project, base);
  await initializeRepository(local, project, github.gitToken());
  return { project, local };
}
async function main() {
  const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { config: { type: "string" } },
    }),
    command = positionals[0];
  if (!["add", "list", "inspect", "disable"].includes(command))
    throw Error(usage);
  if (["inspect", "disable"].includes(command))
    z.string().uuid().parse(positionals[1]);
  let approved: Awaited<ReturnType<typeof validateRegistration>> | undefined;
  if (command === "add") {
    if (!values.config || !process.env.CONDUIT_PROJECTS_FILE)
      throw Error(
        "Set CONDUIT_PROJECTS_FILE and pass --config registration.json",
      );
    approved = await validateRegistration(
      JSON.parse(await readFile(values.config, "utf8")),
      await GitHub.fromEnvironment(),
    );
  }
  const db = adminDatabase();
  let lock: string | undefined;
  try {
    if (command === "list" || command === "inspect") {
      const { rows } = await db.query(
        `SELECT ${projectColumns} FROM orchestrator.projects WHERE ($1::uuid IS NULL OR id=$1) ORDER BY name`,
        [command === "inspect" ? positionals[1] : null],
      );
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (command === "disable") {
      await db.query(
        "UPDATE orchestrator.projects SET enabled=false,updated_at=clock_timestamp() WHERE id=$1",
        [positionals[1]],
      );
      console.log("Project disabled");
      return;
    }
    const { project: p, local } = approved!;
    // Schema-admin access is deliberately separate from the key-admin account.
    const target = resolve(process.env.CONDUIT_PROJECTS_FILE!);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target + ".lock", "wx", 0o600);
    lock = target + ".lock";
    await handle.writeFile(String(process.pid));
    await handle.close();
    let projects: LocalProject[] = [];
    try {
      projects = z
        .array(localProjectSchema)
        .parse(JSON.parse(await readFile(target, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const existing = projects.find((v) => v.project_id === p.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(local))
      throw Error(
        "Local configuration already exists with different content; review it manually",
      );
    await db.query(
      `INSERT INTO orchestrator.projects(id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(id) DO NOTHING`,
      [
        p.id,
        p.name,
        p.repository_owner,
        p.repository_name,
        p.repository_url,
        p.default_branch,
        p.allowed_base_branches,
      ],
    );
    const {
      rows: [stored],
    } = await db.query("SELECT * FROM orchestrator.projects WHERE id=$1", [
      p.id,
    ]);
    if (
      stored.repository_url !== p.repository_url ||
      stored.default_branch !== p.default_branch ||
      JSON.stringify(stored.allowed_base_branches) !==
        JSON.stringify(p.allowed_base_branches) ||
      !stored.enabled
    )
      throw Error(
        "Cloud project already exists with different policy or is disabled",
      );
    if (!existing) projects.push(local);
    await writeFile(target + ".tmp", JSON.stringify(projects, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(target + ".tmp", target);
    console.log(JSON.stringify({ project: p, local_config: target }, null, 2));
  } finally {
    if (lock) await rm(lock, { force: true });
    await db.end();
  }
}
// Importable validation for local repository and mocked GitHub tests.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
)
  main().catch(() => {
    console.error(
      "Project administration failed; check options, private configuration, Git access, rulesets and schema-administrator permissions. " +
        usage,
    );
    process.exitCode = 1;
  });
