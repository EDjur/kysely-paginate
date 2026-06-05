import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithCursorPagination } from "../src";

// Regression coverage for the nullable keyset rewrite: null handling is
// expressed with `IS [NOT] NULL` on the bare column instead of
// `COALESCE(col, sentinel)`, so the predicate stays sargable. The behaviour
// (NULLS LAST ordering, correct paging across the null boundary in both
// directions) must be identical whether or not `dataType` is supplied — the
// old code only entered the nullable branch when `dataType` was present, so
// the no-dataType cases below would have paged incorrectly before the rewrite.

interface DB {
  items: { id: number; priority: number | null };
}

const sqls: string[] = [];

const db = new Kysely<DB>({
  dialect: new SqliteDialect({ database: new Database(":memory:") }),
  log: (event) => {
    if (event.level === "query") {
      sqls.push(event.query.sql);
    }
  },
});

const parseCursor = z.object({
  id: z.coerce.number().int(),
  priority: z.preprocess(
    (v) => (v === null || v === undefined ? null : v),
    z.coerce.number().nullable(),
  ),
});

// id -> priority. Two nulls, a tie on priority (5), so the id tiebreaker and
// the equality tier both get exercised.
const rows: Array<{ id: number; priority: number | null }> = [
  { id: 1, priority: null },
  { id: 2, priority: 5 },
  { id: 3, priority: 5 },
  { id: 4, priority: null },
  { id: 5, priority: 10 },
];

const query = () => db.selectFrom("items").selectAll();

async function walkForward(
  direction: "asc" | "desc",
  withDataType: boolean,
  perPage: number,
) {
  const priorityField = {
    expression: "priority" as const,
    direction,
    nullable: true as const,
    ...(withDataType ? { dataType: "integer" as const } : {}),
  };
  const fields = [
    priorityField,
    { expression: "id" as const, direction: "asc" as const },
  ];

  const collected: number[] = [];
  let after: string | undefined;

  for (let guard = 0; guard < 10; guard++) {
    const page = await executeWithCursorPagination(query(), {
      perPage,
      after,
      fields,
      parseCursor,
    });
    collected.push(...page.rows.map((r) => r.id));
    if (!page.hasNextPage || !page.endCursor) {
      break;
    }
    after = page.endCursor;
  }

  return collected;
}

describe("nullable keyset (sargable)", () => {
  beforeEach(async () => {
    await db.schema.dropTable("items").ifExists().execute();
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (col) => col.primaryKey())
      .addColumn("priority", "integer")
      .execute();
    await db.insertInto("items").values(rows).execute();
    sqls.length = 0;
  });

  afterAll(async () => {
    await db.destroy();
  });

  // NULLS LAST: non-nulls in sort order, then nulls (ordered by the id
  // tiebreaker). Walking every page must reproduce a single full ORDER BY.
  it.each([
    { direction: "asc" as const, expected: [2, 3, 5, 1, 4] },
    { direction: "desc" as const, expected: [5, 2, 3, 1, 4] },
  ])(
    "pages across the null boundary ($direction), with and without dataType",
    async ({ direction, expected }) => {
      expect(await walkForward(direction, true, 2)).toEqual(expected);
      expect(await walkForward(direction, false, 2)).toEqual(expected);
      // A perPage that lands the page boundary exactly on the null transition
      // exercises a null-valued `after` cursor (the equality-tier path).
      expect(await walkForward(direction, false, 3)).toEqual(expected);
    },
  );

  it("walks backward with a 'before' cursor", async () => {
    const fields = [
      {
        expression: "priority" as const,
        direction: "asc" as const,
        nullable: true as const,
      },
      { expression: "id" as const, direction: "asc" as const },
    ];

    // Last page first (forward to the end), then step back with `before`.
    const lastPage = await executeWithCursorPagination(query(), {
      perPage: 2,
      after: undefined,
      fields,
      parseCursor,
    });
    // Forward to the final page.
    let endCursor = lastPage.endCursor;
    let page = lastPage;
    while (page.hasNextPage && page.endCursor) {
      page = await executeWithCursorPagination(query(), {
        perPage: 2,
        after: page.endCursor,
        fields,
        parseCursor,
      });
      endCursor = page.startCursor ?? endCursor;
    }

    const prev = await executeWithCursorPagination(query(), {
      perPage: 2,
      before: page.startCursor,
      fields,
      parseCursor,
    });
    // The page before the final [4] (priority null) is [1] and [5]'s
    // neighbours — i.e. the two rows immediately preceding id=4 in
    // [2,3,5,1,4]: ids 5 and 1.
    expect(prev.rows.map((r) => r.id)).toEqual([5, 1]);
    expect(prev.hasPrevPage).toBe(true);
  });

  it("emits sargable SQL (IS NULL, never COALESCE)", async () => {
    await walkForward("asc", true, 2);

    const cursorSqls = sqls.filter((s) => /where/i.test(s));
    expect(cursorSqls.length).toBeGreaterThan(0);
    expect(cursorSqls.some((s) => /is null|is not null/i.test(s))).toBe(true);
    expect(sqls.every((s) => !/coalesce/i.test(s))).toBe(true);
  });
});
