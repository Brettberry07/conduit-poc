import type { NextConfig } from "next";
const config: NextConfig = {
  async headers() {
    return [
      {
        source: "/app/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  // HTTP integration tests use an isolated build directory beside the normal build.
  typescript: {
    tsconfigPath: process.env.CONDUIT_TEST_TSCONFIG ?? "tsconfig.json",
  },
  distDir: process.env.CONDUIT_TEST_DIST_DIR ?? ".next",
};
export default config;
