import test from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/index.ts";
test("baseline sum", () => assert.equal(sum([1, 2, -1]), 2));
