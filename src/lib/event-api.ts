import { z } from "zod";
import { transaction, type DB } from "./db";
import { DevelopmentError } from "./development";
import type { Identity } from "./keys";

const MAX_CURSOR = "9223372036854775807";
const cursor = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < MAX_CURSOR.length || value <= MAX_CURSOR);
const pageSize = z
  .string()
  .regex(/^(100|[1-9][0-9]?)$/)
  .transform(Number);
const uuid = z.string().uuid();
export const consumerName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const DEFAULT_EVENT_PAGE_SIZE = 50;
const acknowledgement = z
  .object({
    cursor,
    expected_previous_cursor: cursor,
  })
  .strict();
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const columns =
  "id,type,schema_version,occurred_at,project_id,initiative_id,task_key,job_id,root_job_id,data";
const checkpointColumns =
  "name,acknowledged_cursor::text,created_at,acknowledged_at";

async function requireOwnedCursor(db: DB, owner: string, value: string) {
  if (value === "0") return;
  const { rows } = await db.query(
    "SELECT 1 FROM orchestrator.events WHERE owner=$1 AND cursor=$2::bigint",
    [owner, value],
  );
  if (!rows.length)
    throw new DevelopmentError("Cursor is not in this event stream", 400);
}

async function listEvents(db: DB, owner: string, params: URLSearchParams) {
  const query = z
    .object({
      after: cursor.optional(),
      before: uuid.optional(),
      limit: pageSize.optional(),
      initiative_id: uuid.optional(),
      job_id: uuid.optional(),
    })
    .strict()
    .parse(Object.fromEntries(params));
  if (params.size !== new Set(params.keys()).size)
    throw new DevelopmentError("Repeated event query parameter", 400);

  const limit = query.limit ?? DEFAULT_EVENT_PAGE_SIZE;
  const filter = query.initiative_id ?? query.job_id;
  if (filter) {
    if (query.after !== undefined || (query.initiative_id && query.job_id))
      throw new DevelopmentError(
        "Use one history filter with an optional before event ID",
        400,
      );
    const field = query.initiative_id ? "initiative_id" : "job_id";
    const { rows } = await db.query(
      `SELECT ${columns} FROM orchestrator.events e WHERE owner=$1 AND ${field}=$2
       AND ($3::uuid IS NULL OR e.cursor<(
         SELECT anchor.cursor FROM orchestrator.events anchor WHERE anchor.id=$3 AND anchor.owner=$1 AND anchor.${field}=$2
       )) ORDER BY e.cursor DESC LIMIT $4`,
      [owner, filter, query.before ?? null, limit + 1],
    );
    const events = rows.slice(0, limit);
    return json({
      events,
      next_before: events.at(-1)?.id ?? null,
      has_more: rows.length > limit,
    });
  }

  if (query.before !== undefined)
    throw new DevelopmentError(
      "before is only available for filtered history",
      400,
    );
  return json(await readEventPage(db, owner, query.after ?? "0", limit));
}

export async function readEventPage(
  db: DB,
  owner: string,
  after: string,
  limit = DEFAULT_EVENT_PAGE_SIZE,
) {
  await requireOwnedCursor(db, owner, after);
  const { rows } = await db.query(
    `SELECT ${columns},cursor::text FROM orchestrator.events WHERE owner=$1 AND cursor>$2::bigint
     ORDER BY orchestrator.events.cursor LIMIT $3`,
    [owner, after, limit + 1],
  );
  const events = rows.slice(0, limit);
  return {
    events,
    next_after: events.at(-1)?.cursor ?? after,
    has_more: rows.length > limit,
  };
}

export async function readEventConsumer(db: DB, owner: string, name: string) {
  const { rows } = await db.query(
    `SELECT ${checkpointColumns} FROM orchestrator.event_consumers WHERE owner=$1 AND name=$2`,
    [owner, name],
  );
  return (
    rows[0] ?? {
      name,
      acknowledged_cursor: "0",
      created_at: null,
      acknowledged_at: null,
    }
  );
}

export async function eventApi(
  req: Request,
  db: DB,
  key: Identity,
  readBody: (req: Request, max?: number) => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(req.url);
  const match = url.pathname.match(
    /^\/api\/agent\/event-consumers\/([^/]+)(\/ack)?$/,
  );
  const isFeed = url.pathname === "/api/agent/events";
  if (!isFeed && !match) return null;
  if (key.role !== "submitter") return json({ error: "Forbidden" }, 403);
  const owner = key.principal;
  if (isFeed) return listEvents(db, owner, url.searchParams);

  const name = consumerName.parse(match?.[1]);
  if (req.method === "GET")
    return json({ consumer: await readEventConsumer(db, owner, name) });

  const ack = acknowledgement.parse(await readBody(req, 1024));
  if (BigInt(ack.cursor) < BigInt(ack.expected_previous_cursor))
    throw new DevelopmentError("Acknowledgement cannot move backward", 400);

  return transaction(db, async (c) => {
    await requireOwnedCursor(c, owner, ack.cursor);
    await c.query(
      "INSERT INTO orchestrator.event_consumers(owner,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [owner, name],
    );
    const {
      rows: [consumer],
    } = await c.query(
      `SELECT ${checkpointColumns} FROM orchestrator.event_consumers WHERE owner=$1 AND name=$2 FOR UPDATE`,
      [owner, name],
    );
    if (consumer.acknowledged_cursor === ack.cursor) return json({ consumer });
    if (consumer.acknowledged_cursor !== ack.expected_previous_cursor)
      throw new DevelopmentError(
        "Checkpoint conflict; read the current checkpoint",
        409,
      );
    const {
      rows: [updated],
    } = await c.query(
      `UPDATE orchestrator.event_consumers SET acknowledged_cursor=$3,acknowledged_at=clock_timestamp()
       WHERE owner=$1 AND name=$2 RETURNING ${checkpointColumns}`,
      [owner, name, ack.cursor],
    );
    return json({ consumer: updated });
  });
}
