import { z } from "zod";

export const DEVELOPMENT_BODY_LIMIT = 98304;
export const RESEARCH_BYTE_LIMIT = 49152;
const text = (max: number) => z.string().trim().min(1).max(max);
export const sourceUrl = text(2048)
  .url()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((k) =>
        /token|secret|password|api[-_]?key|credential|signature/i.test(k),
      )
    );
  }, "Sources require HTTP(S) URLs without credentials or credential query parameters");

// Deliberately conservative detection of recognizable credentials; arbitrary secrets
// cannot be identified reliably. Never echo submitted content in validation errors.
export function containsCredential(value: unknown): boolean {
  const content = JSON.stringify(value);
  return /(?:cnd_live_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;]{8,}|[a-z][a-z0-9+.-]*:\/\/[^\s/"@]+:[^\s/"@]+@)/i.test(
    content,
  );
}
export const researchSchema = z
  .object({
    objective: text(2000),
    summary: text(6000),
    recommendations: z.array(text(1000)).min(1).max(12),
    sources: z
      .array(
        z
          .object({
            title: text(240),
            url: sourceUrl,
            accessed_at: z.iso.date(),
            relevance: text(1000),
            findings: text(2000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    uncertainties: z.array(text(1000)).max(8).default([]),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= RESEARCH_BYTE_LIMIT,
    "Research exceeds byte limit",
  );
export type Research = z.infer<typeof researchSchema>;
export const preparationFields = {
  development_mode: z.enum(["normal", "detailed"]).optional(),
  original_request: text(12000).optional(),
  policy_version: text(100).optional(),
  research: researchSchema.optional(),
};
export function validatePreparation(
  value: { development_mode?: string; research?: unknown },
  ctx: z.RefinementCtx,
) {
  if (value.development_mode === "detailed" && !value.research)
    ctx.addIssue({
      code: "custom",
      message: "Detailed mode requires a cited research brief",
    });
  if (containsCredential(value))
    ctx.addIssue({
      code: "custom",
      message: "Credentials must not be submitted in job content",
    });
}
