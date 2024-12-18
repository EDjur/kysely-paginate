import {
  OrderByDirectionExpression,
  ReferenceExpression,
  SelectQueryBuilder,
  StringReference,
  sql,
} from "kysely";

declare const SIMPLE_COLUMN_DATA_TYPES: readonly [
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
];
type SimpleColumnDataType = (typeof SIMPLE_COLUMN_DATA_TYPES)[number];

type RequireNullableAndDataType<T> = T &
  (
    | { nullable?: never; dataType?: never }
    | { nullable: boolean; dataType: SimpleColumnDataType }
  );

type SortField<DB, TB extends keyof DB, O> =
  | RequireNullableAndDataType<{
      expression:
        | (StringReference<DB, TB> & keyof O & string)
        | (StringReference<DB, TB> & `${string}.${keyof O & string}`);
      direction: OrderByDirectionExpression;
      key?: keyof O & string;
    }>
  | RequireNullableAndDataType<{
      expression: ReferenceExpression<DB, TB>;
      direction: OrderByDirectionExpression;
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

type Fields<DB, TB extends keyof DB, O> = ReadonlyArray<
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
  [K in TCursorKey extends undefined
    ? never
    : TCursorKey extends false
      ? never
      : TCursorKey extends true
        ? "$cursor"
        : TCursorKey]: string;
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
  },
): Promise<CursorPaginationResult<O, TCursorKey>> {
  const encodeCursor = opts.encodeCursor ?? defaultEncodeCursor;
  const decodeCursor = opts.decodeCursor ?? defaultDecodeCursor;

  const parseCursor =
    typeof opts.parseCursor === "function"
      ? opts.parseCursor
      : opts.parseCursor.parse;

  const fields = opts.fields.map((field) => {
    let key = field.key;

    if (!key && typeof field.expression === "string") {
      const expressionParts = field.expression.split(".");

      key = (expressionParts[1] ?? expressionParts[0]) as
        | (keyof O & string)
        | undefined;
    }

    if (!key) throw new Error("missing key");

    return { ...field, key };
  });

  function generateCursor(row: O): string {
    const cursorFieldValues = fields.map(({ key }) => [
      key,
      row[key],
    ]) as EncodeCursorValues<DB, TB, O, TFields>;

    return encodeCursor(cursorFieldValues);
  }

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

    return qb.where(({ and, or, eb, fn, cast }) => {
      let expression;

      for (let i = fields.length - 1; i >= 0; --i) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const field = fields[i]!;

        const comparison = field.direction === defaultDirection ? ">" : "<";
        const value = cursor[field.key as keyof typeof cursor];

        let conditions = [eb(field.expression, comparison, value)];
        if (field.nullable && field.dataType) {
          const boundaryValue = getBoundaryValue(
            field.direction,
            field.dataType
          );
          if (reversed) {
            conditions = [
              eb(
                field.expression,
                comparison,
                fn.coalesce(
                  sql.val(value),
                  cast(sql.val(boundaryValue), field.dataType)
                )
              ),
            ];
          } else {
            conditions = [
              eb(
                fn.coalesce(
                  field.expression,
                  cast(sql.val(boundaryValue), field.dataType)
                ),
                comparison,
                value
              ),
            ];
          }
        }

        if (expression) {
          const sign = value === null ? "is" : "=";
          conditions.push(and([eb(field.expression, sign, value), expression]));
        }

        expression = or(conditions);
      }

      if (!expression) {
        throw new Error("Error building cursor expression");
      }

      return expression;
    });
  }

  if (opts.after) qb = applyCursor(qb, opts.after, "asc");
  if (opts.before) qb = applyCursor(qb, opts.before, "desc");

  const nullOrder = opts.before ? "FIRST" : "LAST";
  for (const { expression, direction, nullable } of fields) {
    let dir = reversed ? (direction === "asc" ? "desc" : "asc") : direction;

    dir = nullable
      ? sql`${sql.raw(String(dir))} NULLS ${sql.raw(nullOrder)}`
      : dir;

    qb = qb.orderBy(expression, dir);
  }

  const rows = await qb.limit(opts.perPage + 1).execute();

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

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        (row as any)[cursorKey] = generateCursor(row);
      }

      return row as CursorPaginationResultRow<O, TCursorKey>;
    }),
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

const minMaxValues: Record<SimpleColumnDataType, { min: any; max: any }> = {
  varchar: { min: "", max: "\uffff" },
  char: { min: "", max: "\uffff" },
  text: { min: "", max: "\uffff" },
  integer: { min: -2147483648, max: 2147483647 },
  boolean: { min: false, max: true },
  "double precision": { min: -1.7e308, max: 1.7e308 },
  decimal: { min: "-Infinity", max: "Infinity" },
  numeric: { min: "-Infinity", max: "Infinity" },
  date: { min: "0001-01-01", max: "9999-12-31" },
  datetime: { min: "0001-01-01 00:00:00", max: "9999-12-31 23:59:59" },
  time: { min: "00:00:00", max: "23:59:59" },
  timetz: { min: "00:00:00+00", max: "23:59:59+14" },
  timestamp: { min: "0001-01-01 00:00:00", max: "9999-12-31 23:59:59" },
  timestamptz: { min: "0001-01-01 00:00:00+00", max: "9999-12-31 23:59:59+00" },
};

function getBoundaryValue(
  order: OrderByDirectionExpression,
  dataType: SimpleColumnDataType
) {
  const direction = order === "asc" ? "max" : "min";
  if (minMaxValues[dataType]) {
    return minMaxValues[dataType][direction];
  }
  throw new Error(`Unsupported dataType: ${dataType}`);
}
