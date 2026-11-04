import { handle } from "../../../lib/api";
import { database } from "../../../lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const route = (request: Request) => handle(request, database());
export { route as GET, route as POST };
