import { z } from "zod";
import { branchSchema } from "./development";
import {
  containsCredential,
  researchSchema,
  validatePreparation,
} from "./research";

export const INITIATIVE_BODY_LIMIT = 524288;
export const MAX_INITIATIVE_TASKS = 20;
export const MAX_DEPENDENCY_DEPTH = 10;
const text = (max: number) => z.string().trim().min(1).max(max);
export const taskKey = text(64).regex(/^[a-z][a-z0-9-]*$/);
export const plannedTask = z
  .object({
    task_key: taskKey,
    title: text(200),
    description: z.string().max(4000).default(""),
    instructions: text(12000),
    acceptance_criteria: text(4000),
    development_mode: z.enum(["normal", "detailed"]).default("normal"),
    research: researchSchema.optional(),
    dependencies: z.array(taskKey).max(MAX_INITIATIVE_TASKS).default([]),
  })
  .strict()
  .superRefine(validatePreparation);
export const initiativePlan = z
  .object({
    project_id: z.string().uuid(),
    base_branch: branchSchema.optional(),
    title: text(200),
    description: z.string().max(4000).default(""),
    original_request: text(12000),
    goal: text(4000),
    acceptance_criteria: text(4000),
    development_mode: z.enum(["normal", "detailed"]).default("normal"),
    research: researchSchema.optional(),
    tasks: z.array(plannedTask).min(1).max(MAX_INITIATIVE_TASKS),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (containsCredential(plan))
      ctx.addIssue({
        code: "custom",
        message: "Credentials must not be submitted",
      });
    const tasks = new Map(plan.tasks.map((t) => [t.task_key, t]));
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (tasks.size !== plan.tasks.length) issue("Duplicate task keys");
    for (const task of plan.tasks) {
      if (new Set(task.dependencies).size !== task.dependencies.length)
        issue("Duplicate dependency edges");
      for (const dep of task.dependencies) {
        if (!tasks.has(dep)) issue(`Unknown dependency for ${task.task_key}`);
        if (dep === task.task_key) issue("Self-dependency");
      }
    }
    const visiting = new Set<string>(),
      depths = new Map<string, number>();
    const depth = (key: string): number => {
      if (visiting.has(key)) {
        issue("Cyclic dependencies");
        return 0;
      }
      if (depths.has(key)) return depths.get(key)!;
      visiting.add(key);
      const d =
        1 +
        Math.max(
          0,
          ...(tasks.get(key)?.dependencies ?? []).map((dep) =>
            tasks.has(dep) ? depth(dep) : 0,
          ),
        );
      visiting.delete(key);
      depths.set(key, d);
      return d;
    };
    for (const key of tasks.keys())
      if (depth(key) > MAX_DEPENDENCY_DEPTH)
        issue("Dependency depth exceeds 10 tasks");
  });
export type InitiativePlan = z.infer<typeof initiativePlan>;
export const createInitiative = z
  .object({ plan: initiativePlan, policy_version: text(100).optional() })
  .strict();
export const editInitiative = z
  .object({
    expected_plan_version: z.number().int().positive(),
    plan: initiativePlan,
    explanation: text(2000).optional(),
  })
  .strict();
export const activationInput = z
  .object({
    expected_plan_version: z.number().int().positive(),
    policy_version: text(100).optional(),
  })
  .strict();
export const reviewInput = z
  .object({
    task_key: taskKey,
    job_id: z.string().uuid(),
    observed_head_sha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    outcome: z.enum([
      "ready_for_human_review",
      "revision_needed",
      "blocked",
      "needs_decision",
    ]),
    summary: text(2000),
    criteria_evaluated: z.array(text(1000)).min(1).max(20),
    evidence_references: z.array(text(2048)).max(20).default([]),
    outstanding_concerns: z.array(text(1000)).max(20).default([]),
  })
  .strict()
  .refine((v) => !containsCredential(v), "Credentials must not be submitted");

export const lifecycleInput = z
  .object({
    expected_status: z.enum(["draft", "active", "paused"]),
    status: z.enum(["active", "paused", "completed", "cancelled"]),
    completion_summary: text(4000).optional(),
  })
  .strict()
  .refine((v) => !containsCredential(v), "Credentials must not be submitted");
