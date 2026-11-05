import type { NextConfig } from "next";
const config: NextConfig = {
  // HTTP integration tests use an isolated build directory beside the normal build.
  typescript: {
    tsconfigPath: process.env.CONDUIT_TEST_TSCONFIG ?? "tsconfig.json",
  },
  distDir: process.env.CONDUIT_TEST_DIST_DIR ?? ".next",
};
export default config;
