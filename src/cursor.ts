import {
  type AbortableQueryOptions,
  type Expression,
  type OrderByDirection,
  type OrderByItemBuilder,
  ReferenceExpression,
  SelectQueryBuilder,
  type SqlBool,
  StringReference,
  sql,
} from "kysely";

export const SIMPLE_COLUMN_DATA_TYPES = [
  "varchar",
  "char",
  "text",
  "integer",
  "boolean",
  "double precision",
  "decimal",
  "numeric",
  "date",
  "datetime",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
] as const;
export type SimpleColumnDataType = (typeof SIMPLE_COLUMN_DATA_TYPES)[number];

type RequireNullableAndDataType<T> = T &
  (
    | { nullable?: never; dataType?: never }
    | { nullable: boolean; dataType?: SimpleColumnDataType }
  );

export type SortField<DB, TB extends keyof DB, O> =
  | RequireNullableAndDataType<{
      expression:
        | (StringReference<DB, TB> & keyof O & string)
        | (StringReference<DB, TB> & `${string}.${keyof O & string}`);
      direction: OrderByDirection;
      key?: keyof O & string;
    }>
  | RequireNullableAndDataType<{
      expression: ReferenceExpression<DB, TB>;
      direction: OrderByDirection;
      key: keyof O & string;
    }>;

type ExtractSortFieldKey<
  DB,
  TB extends keyof DB,
  O,
  T extends SortField<DB, TB, O>,
> = T["key"] extends keyof O & string
  ? T["key"]
  : T["expression"] extends keyof O & string
    ? T["expression"]
    : T["expression"] extends `${string}.${infer K}`
      ? K extends keyof O & string
        ? K
        : never
      : never;

export type Fields<DB, TB extends keyof DB, O> = ReadonlyArray<
  Readonly<SortField<DB, TB, O>>
>;

type FieldNames<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
  [TIndex in keyof T]: ExtractSortFieldKey<DB, TB, O, T[TIndex]>;
};

type EncodeCursorValues<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
> = {
  [TIndex in keyof T]: [
    ExtractSortFieldKey<DB, TB, O, T[TIndex]>,
    O[ExtractSortFieldKey<DB, TB, O, T[TIndex]>],
  ];
};

export type CursorEncoder<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
> = (values: EncodeCursorValues<DB, TB, O, T>) => string;

type DecodedCursor<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
  [TField in ExtractSortFieldKey<DB, TB, O, T[number]>]: string;
};

export type CursorDecoder<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
> = (
  cursor: string,
  fields: FieldNames<DB, TB, O, T>,
) => DecodedCursor<DB, TB, O, T>;

type ParsedCursorValues<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
> = {
  [TField in ExtractSortFieldKey<DB, TB, O, T[number]>]: O[TField];
};

export type CursorParser<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
> = (cursor: DecodedCursor<DB, TB, O, T>) => ParsedCursorValues<DB, TB, O, T>;

type CursorPaginationResultRow<
  TRow,
  TCursorKey extends string | boolean | undefined,
> = TRow & {
  [
    K in TCursorKey extends undefined
      ? never
      : TCursorKey extends false
        ? never
        : TCursorKey extends true
          ? "$cursor"
          : TCursorKey
  ]: string;
};

export type CursorPaginationResult<
  TRow,
  TCursorKey extends string | boolean | undefined,
> = {
  startCursor: string | undefined;
  endCursor: string | undefined;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  rows: CursorPaginationResultRow<TRow, TCursorKey>[];
};

/**
 * Resolve the cursor key for a sort field: an explicit `key`, else the column
 * from a string `expression` (the part after the dot for a `table.column`
 * reference). Throws when neither is available — a non-string expression (raw
 * SQL / function call) must declare an explicit `key`.
 */
function resolveFieldKey(field: { key?: string; expression: unknown }): string {
  if (field.key) {
    return field.key;
  }

  if (typeof field.expression === "string") {
    const parts = field.expression.split(".");
    const key = parts[1] ?? parts[0];
    if (key) {
      return key;
    }
  }

  throw new Error("missing key");
}

export async function executeWithCursorPagination<
  DB,
  TB extends keyof DB,
  O,
  const TFields extends Fields<DB, TB, O>,
  TCursorKey extends string | boolean | undefined = undefined,
>(
  qb: SelectQueryBuilder<DB, TB, O>,
  opts: {
    perPage: number;
    after?: string;
    before?: string;
    cursorPerRow?: TCursorKey;
    fields: TFields;
    encodeCursor?: CursorEncoder<DB, TB, O, TFields>;
    decodeCursor?: CursorDecoder<DB, TB, O, TFields>;
    parseCursor:
      | CursorParser<DB, TB, O, TFields>
      | { parse: CursorParser<DB, TB, O, TFields> };
    /**
     * Passed straight to `.execute()` on the page query, so a caller can hand
     * it an `AbortSignal` and an inflight abort strategy.
     */
    executeOptions?: AbortableQueryOptions;
  },
): Promise<CursorPaginationResult<O, TCursorKey>> {
  const decodeCursor = opts.decodeCursor ?? defaultDecodeCursor;

  const parseCursor =
    typeof opts.parseCursor === "function"
      ? opts.parseCursor
      : opts.parseCursor.parse;

  const fields = opts.fields.map((field) => ({
    ...field,
    key: resolveFieldKey(field) as keyof O & string,
  }));

  const generateCursor = getCursorEncoder<DB, TB, O, TFields>({
    encodeCursor: opts.encodeCursor,
    fields: opts.fields,
  });

  const fieldNames = fields.map((field) => field.key) as FieldNames<
    DB,
    TB,
    O,
    TFields
  >;

  const reversed = !!opts.before && !opts.after;

  function applyCursor(
    qb: SelectQueryBuilder<DB, TB, O>,
    encoded: string,
    defaultDirection: "asc" | "desc",
  ) {
    const decoded = decodeCursor(encoded, fieldNames);
    const cursor = parseCursor(decoded);

    return qb.where(({ and, or, eb }) => {
      let expression;

      for (let i = fields.length - 1; i >= 0; --i) {
        const field = fields[i]!;

        const comparison = field.direction === defaultDirection ? ">" : "<";
        const value = cursor[field.key as keyof typeof cursor];

        // Term selecting rows strictly past the cursor on THIS field. Null
        // handling uses `IS [NOT] NULL` rather than COALESCE(col, sentinel) so
        // the predicate stays sargable — a b-tree index on the bare column is
        // still usable. Nulls sort last in the presented order (the ORDER BY
        // below uses NULLS LAST forward, mirrored under reverse).
        const conditions: Expression<SqlBool>[] = [];
        if (!field.nullable) {
          conditions.push(eb(field.expression, comparison, value));
        } else if (reversed) {
          // 'before': nulls trail the order, so a non-null cursor value has no
          // nulls before it; a null cursor value sits in that trailing region,
          // so every non-null row precedes it.
          conditions.push(
            value === null
              ? eb(field.expression, "is not", null)
              : eb(field.expression, comparison, value),
          );
        } else if (value !== null) {
          // 'after': a null row sorts after any non-null value. Nothing sorts
          // after a null cursor value, so when value === null we add no advance
          // term and let the equality tier below ('IS NULL AND <rest>') carry.
          conditions.push(
            or([
              eb(field.expression, comparison, value),
              eb(field.expression, "is", null),
            ]),
          );
        }

        if (expression) {
          const sign = value === null ? "is" : "=";
          conditions.push(and([eb(field.expression, sign, value), expression]));
        }

        expression =
          conditions.length > 0 ? or(conditions) : eb(sql`1`, "=", 0);
      }

      if (!expression) {
        throw new Error("Error building cursor expression");
      }

      return expression;
    });
  }

  if (opts.after) qb = applyCursor(qb, opts.after, "asc");
  if (opts.before) qb = applyCursor(qb, opts.before, "desc");

  const nullsPosition = opts.before ? "first" : "last";
  for (const { expression, direction, nullable } of fields) {
    const dir = reversed ? (direction === "asc" ? "desc" : "asc") : direction;

    if (nullable) {
      qb = qb.orderBy(expression, (ob: OrderByItemBuilder) =>
        dir === "asc"
          ? nullsPosition === "first"
            ? ob.asc().nullsFirst()
            : ob.asc().nullsLast()
          : nullsPosition === "first"
            ? ob.desc().nullsFirst()
            : ob.desc().nullsLast(),
      );
    } else {
      qb = qb.orderBy(expression, dir);
    }
  }

  const rows = await qb.limit(opts.perPage + 1).execute(opts.executeOptions);

  const hasNextPage = reversed ? undefined : rows.length > opts.perPage;
  const hasPrevPage = !reversed ? undefined : rows.length > opts.perPage;

  // If we fetched an extra row to determine if we have a next page, that
  // shouldn't be in the returned results
  if (rows.length > opts.perPage) rows.pop();

  if (reversed) rows.reverse();

  const startRow = rows[0];
  const endRow = rows[rows.length - 1];

  const startCursor = startRow ? generateCursor(startRow) : undefined;
  const endCursor = endRow ? generateCursor(endRow) : undefined;

  return {
    startCursor,
    endCursor,
    hasNextPage,
    hasPrevPage,
    rows: rows.map((row) => {
      if (opts.cursorPerRow) {
        const cursorKey =
          typeof opts.cursorPerRow === "string" ? opts.cursorPerRow : "$cursor";

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (row as any)[cursorKey] = generateCursor(row);
      }

      return row as CursorPaginationResultRow<O, TCursorKey>;
    }),
  };
}

/**
 * Build a cursor encoder bound to a set of sort fields. The returned function
 * encodes one row's cursor — the exact value {@link executeWithCursorPagination}
 * produces for that row. Useful for "find the page containing row X" lookups:
 * scan ids in sort order, locate the anchor, then encode just that single row
 * instead of paying `cursorPerRow`'s per-row encode across the whole scan.
 */
export function getCursorEncoder<
  DB,
  TB extends keyof DB,
  O,
  const TFields extends Fields<DB, TB, O> = Fields<DB, TB, O>,
>(opts: {
  fields: TFields;
  encodeCursor?: CursorEncoder<DB, TB, O, TFields>;
}): (row: O) => string {
  const encodeCursor = opts.encodeCursor ?? defaultEncodeCursor;
  const keys = opts.fields.map(
    (field) => resolveFieldKey(field) as keyof O & string,
  );

  return (row) => {
    const cursorFieldValues = keys.map((key) => [
      key,
      row[key],
    ]) as EncodeCursorValues<DB, TB, O, TFields>;

    return encodeCursor(cursorFieldValues);
  };
}

export function defaultEncodeCursor<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
>(values: EncodeCursorValues<DB, TB, O, T>) {
  const cursor = new URLSearchParams();

  for (const [key, value] of values) {
    switch (typeof value) {
      case "string":
        cursor.set(key, value);
        break;

      case "number":
      case "bigint":
        cursor.set(key, value.toString(10));
        break;

      case "object": {
        if (value === null) {
          cursor.set(key, "null");
          break;
        }
        if (value instanceof Date) {
          cursor.set(key, value.toISOString());
          break;
        }
      }

      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unable to encode '${key.toString()}'`);
    }
  }

  return Buffer.from(cursor.toString(), "utf8").toString("base64url");
}

export function defaultDecodeCursor<
  DB,
  TB extends keyof DB,
  O,
  T extends Fields<DB, TB, O>,
>(
  cursor: string,
  fields: FieldNames<DB, TB, O, T>,
): DecodedCursor<DB, TB, O, T> {
  let parsed;

  try {
    parsed = [
      ...new URLSearchParams(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ).entries(),
    ] as [string, string | null][];
  } catch {
    throw new Error("Unparsable cursor");
  }

  if (parsed.length !== fields.length) {
    throw new Error("Unexpected number of fields");
  }

  for (let i = 0; i < fields.length; i++) {
    const field = parsed[i];
    const expectedName = fields[i];

    if (!field) {
      throw new Error("Unable to find field");
    }

    if (field[0] !== expectedName) {
      throw new Error("Unexpected field name");
    }

    if (field[1] === "null") {
      field[1] = null;
    }
  }

  return Object.fromEntries(parsed) as DecodedCursor<DB, TB, O, T>;
}
