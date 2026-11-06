import { handle } from "../../../lib/api";
import { database } from "../../../lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
async function route(request: Request) {
  try {
    return await handle(request, database());
  } catch {
    console.error(JSON.stringify({ event: "api_configuration_error" }));
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export { route as GET, route as POST, route as PATCH };
