---
"@edjur/kysely-paginate": minor
---

Let a cursor page seek its sort index, and throw a typed error for a cursor
that cannot be read.

A sort field can now set `seek: true`. The cursor predicate then also bounds
that field by the cursor value, `>=` or `<=` by direction, next to the
`a > x OR (a = x AND id > y)` keyset. The bound adds nothing the OR does not
already imply, so results do not change. It lets Postgres use an index on the
field as an index condition, so a page deep in a large list seeks to the
cursor instead of reading and discarding every earlier row. `seek` is allowed
only on the leading, non-nullable field, and anything else throws.

```ts
await executeWithCursorPagination(query, {
  perPage: 20,
  fields: [
    { expression: "createdAt", direction: "desc", seek: true },
    { expression: "id", direction: "asc" },
  ],
  parseCursor,
});
```

A cursor that cannot be decoded, was written for other sort fields, or that
`parseCursor` refuses now throws `InvalidCursorError`, with the original
error as its `cause`. Before, these were plain `Error`s or whatever the parser
threw, so a caller could not tell bad input from a fault.
