import { info } from "../../lib/info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Public static descriptor; use /api/workers for live readiness.
export function GET(request: Request): Response {
  return info(request);
}
