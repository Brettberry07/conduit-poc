import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialScopes } from "../src/lib/keys";
import { createKeyOptions, credentialRoles } from "../scripts/key-options";

test("viewer has exactly jobs:read and satisfies the submitter scope constraint", () => {
  assert.deepEqual(credentialScopes.viewer, ["jobs:read"]);
  const allowed = new Set(["jobs:create", "jobs:read", "jobs:revise"]);
  assert.ok(credentialScopes.viewer.length > 0);
  assert.ok(credentialScopes.viewer.every((scope) => allowed.has(scope)));
  assert.equal(credentialRoles.viewer, "submitter");
});

test("CLI accepts viewer and preserves existing credential scopes and roles", () => {
  for (const [type, role, scopes] of [
    ["viewer", "submitter", ["jobs:read"]],
    ["instinct", "submitter", ["jobs:create", "jobs:read", "jobs:revise"]],
    ["worker", "worker", ["jobs:claim", "jobs:update"]],
  ] as const) {
    const input = createKeyOptions.parse({
      type,
      principal: "test-owner",
      name: "Test key",
      days: "30",
    });
    assert.equal(input.type, type);
    assert.equal(credentialRoles[input.type], role);
    assert.deepEqual(credentialScopes[input.type], scopes);
  }
  assert.equal(
    createKeyOptions.safeParse({
      type: "admin",
      principal: "test-owner",
      name: "Test key",
      days: "30",
    }).success,
    false,
  );
});
