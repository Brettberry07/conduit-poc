import { info } from "../../lib/info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function GET(request: Request) {
  return info(request);
}
