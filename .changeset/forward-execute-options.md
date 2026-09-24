---
"@edjur/kysely-paginate": minor
---

Forward `executeOptions` to the queries the pagination helpers run.

`executeWithCursorPagination` and `executeWithOffsetPagination` now accept an
optional `executeOptions`, passed straight to `.execute()`. A caller can hand
them an `AbortSignal` and an inflight abort strategy, so an abandoned request
can cancel the page query on the database side instead of holding its pool
connection until the query finishes.

```ts
await executeWithCursorPagination(query, {
  perPage: 20,
  fields: [{ expression: "id", direction: "asc" }],
  parseCursor: z.object({ id: z.coerce.number().int() }),
  executeOptions: { signal, inflightQueryAbortStrategy: "cancel query" },
});
```

This needs kysely 0.29 or later, which is where `AbortableQueryOptions` and
`.execute(options)` arrive. The peer range is now `>=0.29.0`, and because
kysely 0.29 itself requires Node 22, the package's `engines` moves to
`>= 22.0.0` and CI drops Node 16, 18 and 20.
