import { test } from "node:test";
import { githubSmoke } from "../scripts/github-smoke";
test(
  "opt-in private GitHub + hosted API + real Mac Codex + same-PR revision",
  {
    skip: process.env.CONDUIT_RUN_GITHUB_INTEGRATION !== "1",
    timeout: 1800000,
  },
  githubSmoke,
);
