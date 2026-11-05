import { test } from "node:test";
import assert from "node:assert/strict";
import { health, authCheck } from "../src/lib/checks";
import { generateKey } from "../src/lib/keys";
test("readiness and authentication failures return 503 without credentials or database errors", async () => {
  const secret = generateKey().token;
  const failing = () => {
    throw Error("Connection failure with password " + secret);
  };
  const readiness = await health(failing);
  assert.equal(readiness.status, 503);
  assert.ok(!(await readiness.text()).includes(secret));
  const auth = await authCheck(
    new Request("http://localhost/auth-check", {
      headers: { Authorization: `Bearer ${secret}` },
    }),
    failing,
  );
  assert.equal(auth.status, 503);
  assert.deepEqual(await auth.json(), { error: "Service unavailable" });
});
