import {
  type AbortableQueryOptions,
  SelectQueryBuilder,
  StringReference,
  sql,
} from "kysely";

export type OffsetPaginationResult<O> = {
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  rows: O[];
};

export async function executeWithOffsetPagination<O, DB, TB extends keyof DB>(
  qb: SelectQueryBuilder<DB, TB, O>,
  opts: {
    perPage: number;
    page: number;
    experimental_deferredJoinPrimaryKey?: StringReference<DB, TB>;
    /**
     * Passed straight to `.execute()` on every statement this runs, so a
     * caller can hand it an `AbortSignal` and an inflight abort strategy.
     */
    executeOptions?: AbortableQueryOptions;
  },
): Promise<OffsetPaginationResult<O>> {
  qb = qb.limit(opts.perPage + 1).offset((opts.page - 1) * opts.perPage);

  const deferredJoinPrimaryKey = opts.experimental_deferredJoinPrimaryKey;

  if (deferredJoinPrimaryKey) {
    const primaryKeys = await qb
      .clearSelect()
      .select((eb) => eb.ref(deferredJoinPrimaryKey).as("primaryKey"))
      .execute(opts.executeOptions)
      // @ts-expect-error TODO: Fix the type here later
      .then((rows) => rows.map((row) => row.primaryKey));

    qb = qb
      .where((eb) =>
        primaryKeys.length > 0
          ? eb(deferredJoinPrimaryKey, "in", primaryKeys as any)
          : eb(sql`1`, "=", 0),
      )
      .clearOffset()
      .clearLimit();
  }

  const rows = await qb.execute(opts.executeOptions);
  const hasNextPage = rows.length > 0 ? rows.length > opts.perPage : undefined;
  const hasPrevPage = rows.length > 0 ? opts.page > 1 : undefined;

  // If we fetched an extra row to determine if we have a next page, that
  // shouldn't be in the returned results
  if (rows.length > opts.perPage) {
    rows.pop();
  }

  return {
    hasNextPage,
    hasPrevPage,
    rows,
  };
}
