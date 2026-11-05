import { authCheck } from "../../lib/checks";
import { database } from "../../lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export function GET(request: Request) {
  return authCheck(request, database);
}
