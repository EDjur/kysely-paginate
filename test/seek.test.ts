import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CursorPaginationResult,
  executeWithCursorPagination,
  InvalidCursorError,
} from "../src";
import { createSampleBlogPosts, databases, setupDatabase } from "./db";

type Direction = "asc" | "desc";
type Post = { id: number; authorId: number };

const parseCursor = z.object({
  authorId: z.coerce.number().int(),
  id: z.coerce.number().int(),
});

const combinations = (["asc", "desc"] as const).flatMap((lead) =>
  (["asc", "desc"] as const).map((tiebreak) => ({ lead, tiebreak })),
);

// `authorId` holds two values across 13 posts, so most page boundaries fall
// inside a tie and the id tiebreaker decides them.
databases.forEach(([kind, db]) => {
  describe(`${kind}: seek on the leading field`, () => {
    beforeAll(async () => await setupDatabase(db));

    beforeEach(async () => {
      await db.deleteFrom("blogPosts").execute();
      await createSampleBlogPosts(db, 13);
    });

    const fieldsFor = (lead: Direction, tiebreak: Direction) =>
      [
        { expression: "authorId", direction: lead, seek: true },
        { expression: "id", direction: tiebreak },
      ] as const;

    const query = () => db.selectFrom("blogPosts").select(["id", "authorId"]);

    async function expected(lead: Direction, tiebreak: Direction) {
      const rows = await query()
        .orderBy("authorId", lead)
        .orderBy("id", tiebreak)
        .execute();
      return rows.map((row) => row.id);
    }

    async function walkForward(lead: Direction, tiebreak: Direction) {
      const ids: number[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await executeWithCursorPagination(query(), {
          perPage: 3,
          after,
          fields: fieldsFor(lead, tiebreak),
          parseCursor,
        });
        ids.push(...page.rows.map((row) => row.id));
        if (!page.hasNextPage || !page.endCursor) {
          break;
        }
        after = page.endCursor;
      }
      return ids;
    }

    async function walkBackward(lead: Direction, tiebreak: Direction) {
      const all = await executeWithCursorPagination(query(), {
        perPage: 100,
        fields: fieldsFor(lead, tiebreak),
        parseCursor,
        cursorPerRow: true,
      });
      const last = all.rows[all.rows.length - 1]!;
      const ids: number[] = [last.id];
      let before: string | undefined = last.$cursor;
      for (let guard = 0; guard < 20; guard++) {
        const page: CursorPaginationResult<Post, undefined> =
          await executeWithCursorPagination(query(), {
            perPage: 3,
            before,
            fields: fieldsFor(lead, tiebreak),
            parseCursor,
          });
        ids.unshift(...page.rows.map((row) => row.id));
        if (!page.hasPrevPage || !page.startCursor) {
          break;
        }
        before = page.startCursor;
      }
      return ids;
    }

    it.each(combinations)(
      "walks forward through every row once (lead $lead, tiebreak $tiebreak)",
      async ({ lead, tiebreak }) => {
        expect(await walkForward(lead, tiebreak)).toEqual(
          await expected(lead, tiebreak),
        );
      },
    );

    it.each(combinations)(
      "walks backward through every row once (lead $lead, tiebreak $tiebreak)",
      async ({ lead, tiebreak }) => {
        expect(await walkBackward(lead, tiebreak)).toEqual(
          await expected(lead, tiebreak),
        );
      },
    );
  });
});

describe("seek SQL", () => {
  const sqls: string[] = [];
  const db = new Kysely<{ items: { id: number; rank: number | null } }>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
    log: (event) => {
      if (event.level === "query") {
        sqls.push(event.query.sql);
      }
    },
  });
  const itemCursor = z.object({
    id: z.coerce.number().int(),
    rank: z.coerce.number().int(),
  });
  const cursor = Buffer.from("rank=5&id=2").toString("base64url");

  beforeAll(async () => {
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (col) => col.primaryKey())
      .addColumn("rank", "integer")
      .execute();
  });

  beforeEach(() => {
    sqls.length = 0;
  });

  afterAll(async () => {
    await db.destroy();
  });

  it.each([
    { page: "after", direction: "asc", bound: ">=" },
    { page: "after", direction: "desc", bound: "<=" },
    { page: "before", direction: "asc", bound: "<=" },
    { page: "before", direction: "desc", bound: ">=" },
  ] as const)(
    "bounds the leading field with $bound for a $page cursor on a $direction sort",
    async ({ page, direction, bound }) => {
      await executeWithCursorPagination(db.selectFrom("items").selectAll(), {
        perPage: 2,
        [page]: cursor,
        fields: [
          { expression: "rank", direction, seek: true },
          { expression: "id", direction: "asc" },
        ],
        parseCursor: itemCursor,
      });

      expect(sqls[0]).toContain(`where ("rank" ${bound} ? and (`);
    },
  );

  it("leaves the predicate alone without seek", async () => {
    await executeWithCursorPagination(db.selectFrom("items").selectAll(), {
      perPage: 2,
      after: cursor,
      fields: [
        { expression: "rank", direction: "asc" },
        { expression: "id", direction: "asc" },
      ],
      parseCursor: itemCursor,
    });

    expect(sqls[0]).not.toMatch(/>=|<=/);
  });

  it.each([
    {
      name: "a field after the first",
      fields: [
        { expression: "rank", direction: "asc" },
        { expression: "id", direction: "asc", seek: true },
      ],
    },
    {
      name: "a nullable field",
      fields: [
        { expression: "rank", direction: "asc", nullable: true, seek: true },
        { expression: "id", direction: "asc" },
      ],
    },
  ] as const)("refuses seek on $name", async ({ fields }) => {
    await expect(
      executeWithCursorPagination(db.selectFrom("items").selectAll(), {
        perPage: 2,
        fields,
        parseCursor: itemCursor,
      }),
    ).rejects.toThrowError(/'seek' needs the leading, non-nullable/);
  });
});

describe("InvalidCursorError", () => {
  const db = new Kysely<{ items: { id: number; rank: number } }>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
  });
  const fields = [
    { expression: "rank", direction: "asc" },
    { expression: "id", direction: "asc" },
  ] as const;
  const parseCursor = z.object({
    id: z.coerce.number().int(),
    rank: z.coerce.number().int(),
  });
  const encode = (text: string) => Buffer.from(text).toString("base64url");

  afterAll(async () => {
    await db.destroy();
  });

  it.each([
    { name: "too few fields", cursor: encode("rank=5") },
    { name: "a field it was not written for", cursor: encode("rank=5&uid=2") },
    { name: "a value parseCursor refuses", cursor: encode("rank=high&id=2") },
  ])("is thrown for a cursor with $name", async ({ cursor }) => {
    const page = executeWithCursorPagination(
      db.selectFrom("items").selectAll(),
      { perPage: 2, after: cursor, fields, parseCursor },
    );

    await expect(page).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("keeps the parser's error as the cause", async () => {
    const error = await executeWithCursorPagination(
      db.selectFrom("items").selectAll(),
      {
        perPage: 2,
        before: encode("rank=high&id=2"),
        fields,
        parseCursor,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidCursorError);
    expect((error as InvalidCursorError).cause).toBeInstanceOf(z.ZodError);
  });
});
