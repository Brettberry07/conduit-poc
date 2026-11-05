import { z } from "zod";
import type { credentialScopes, Identity } from "../src/lib/keys";

export const credentialRoles = {
  instinct: "submitter",
  viewer: "submitter",
  worker: "worker",
} as const satisfies Record<keyof typeof credentialScopes, Identity["role"]>;

export const createKeyOptions = z.object({
  type: z.enum(["instinct", "worker", "viewer"]),
  principal: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(120),
  days: z.coerce.number().int().min(1).max(3650),
});
