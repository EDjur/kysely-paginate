import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  executeWithCursorPagination,
  type Fields,
  getCursorEncoder,
} from "../src";

// `getCursorEncoder` must produce the exact cursor that `cursorPerRow` stamps
// on a row, so a "find the page containing row X" lookup can encode just the
// anchor row instead of running cursorPerRow over the whole scan.

type Row = { id: number; priority: number | null };

interface DB {
  items: Row;
}

const db = new Kysely<DB>({
  dialect: new SqliteDialect({ database: new Database(":memory:") }),
});

// Annotated (rather than inferred from a query) so the standalone
// getCursorEncoder call below has DB/TB/O context to bind its generics to.
const fields: Fields<DB, "items", Row> = [
  { expression: "priority", direction: "asc" },
  { expression: "id", direction: "asc" },
];

const parseCursor = z.object({
  id: z.coerce.number().int(),
  priority: z.preprocess(
    (v) => (v === null || v === undefined ? null : v),
    z.coerce.number().nullable(),
  ),
});

describe("getCursorEncoder", () => {
  beforeEach(async () => {
    await db.schema.dropTable("items").ifExists().execute();
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (col) => col.primaryKey())
      .addColumn("priority", "integer")
      .execute();
    await db
      .insertInto("items")
      .values([
        { id: 1, priority: 5 },
        { id: 2, priority: null },
        { id: 3, priority: 10 },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("matches the per-row cursor cursorPerRow stamps", async () => {
    const result = await executeWithCursorPagination(
      db.selectFrom("items").selectAll(),
      { perPage: 10, cursorPerRow: true, fields, parseCursor },
    );

    const encode = getCursorEncoder<DB, "items", Row>({ fields });

    for (const row of result.rows) {
      expect(encode(row)).toEqual(row.$cursor);
    }
    // And the last row's encoded cursor is the page's endCursor.
    expect(encode(result.rows[result.rows.length - 1]!)).toEqual(
      result.endCursor,
    );
  });

  it("honours a custom encodeCursor", () => {
    const encode = getCursorEncoder<DB, "items", Row>({
      fields,
      encodeCursor: (values) =>
        values.map(([k, v]) => `${String(k)}:${String(v)}`).join("|"),
    });

    expect(encode({ id: 7, priority: null })).toEqual("priority:null|id:7");
  });
});
