import { test } from "node:test";
import assert from "node:assert/strict";
import { transaction, type DBConnection, type PooledDB } from "../src/lib/db";

function fixture(rollbackFailure?: Error) {
  const statements: string[] = [];
  const releases: (Error | boolean | undefined)[] = [];
  let acquisitions = 0;
  const connection: DBConnection = {
    async query(sql) {
      statements.push(sql);
      if (sql === "ROLLBACK" && rollbackFailure) throw rollbackFailure;
      return { rows: [], rowCount: 0 };
    },
    release(error) {
      releases.push(error);
    },
  };
  const pool: PooledDB = {
    async query() {
      throw Error("Transaction used the pool instead of its connection");
    },
    async connect() {
      acquisitions++;
      return connection;
    },
  };
  return {
    pool,
    connection,
    statements,
    releases,
    acquisitions: () => acquisitions,
  };
}

test("transaction commits on its dedicated connection and releases it", async () => {
  const f = fixture();
  const result = await transaction(f.pool, async (connection) => {
    assert.equal(connection, f.connection);
    await connection.query("SELECT 1");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(f.acquisitions(), 1);
  assert.deepEqual(f.statements, ["BEGIN", "SELECT 1", "COMMIT"]);
  assert.deepEqual(f.releases, [undefined]);
});

test("transaction rolls back callback errors and releases its connection", async () => {
  const f = fixture();
  const failure = Error("Claim failed");
  await assert.rejects(
    transaction(f.pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.statements, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [undefined]);
});

test("transaction discards a connection after rollback failure and preserves the original error", async () => {
  const rollbackFailure = Error("Connection lost during rollback");
  const f = fixture(rollbackFailure);
  const failure = Error("Claim failed");
  await assert.rejects(
    transaction(f.pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.statements, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [rollbackFailure]);
});
