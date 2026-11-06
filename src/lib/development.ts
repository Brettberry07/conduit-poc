import { z } from "zod";
import type { DB } from "./db";
import {
  preparationFields,
  validatePreparation,
  containsCredential,
} from "./research";
export const branchSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
  .refine(
    (s) =>
      !s.includes("..") &&
      !s.includes("//") &&
      !s.endsWith("/") &&
      !s.endsWith(".") &&
      !s.endsWith(".lock") &&
      !s.split("/").some((p) => p.startsWith(".")),
  );
export function featureBranch(id: string, title: string) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "development";
  return `conduit/job-${id}-${slug}`;
}
export class DevelopmentError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const projectColumns =
  "id,name,repository_owner,repository_name,repository_url,default_branch,allowed_base_branches,enabled,created_at,updated_at";
export async function approvedProject(db: DB, id: string, base?: string) {
  const {
    rows: [project],
  } = await db.query(
    `SELECT ${projectColumns} FROM orchestrator.projects WHERE id=$1 AND enabled`,
    [id],
  );
  if (!project)
    throw new DevelopmentError("Project is not registered or enabled", 400);
  const branch = base ?? project.default_branch;
  if (!project.allowed_base_branches.includes(branch))
    throw new DevelopmentError("Base branch is not approved", 400);
  return { project, branch };
}
export const developmentInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    task: z.literal("development"),
    ...preparationFields,
    development_mode: preparationFields.development_mode.default("normal"),
    project_id: z.string().uuid(),
    instructions: z.string().trim().min(1).max(12000),
    acceptance_criteria: z.string().max(4000).default(""),
    base_branch: branchSchema.optional(),
    dependency_job_ids: z
      .array(z.string().uuid())
      .max(20)
      .default([])
      .refine((a) => new Set(a).size === a.length),
  })
  .strict()
  .superRefine(validatePreparation);
export const revisionInput = z
  .object({
    ...preparationFields,
    instructions: z.string().trim().min(1).max(12000),
    acceptance_criteria: z.string().max(4000).default(""),
  })
  .strict()
  .refine(
    (v) => !containsCredential(v),
    "Credentials must not be submitted in job content",
  );
