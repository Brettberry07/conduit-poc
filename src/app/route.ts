import { landingPage } from "../lib/public-page";

export const dynamic = "force-static";

export function GET() {
  return new Response(landingPage(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
