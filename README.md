# kysely-paginate
Pagination helpers for use with [Kysely](https://github.com/kysely-org/kysely).

> :warning: **This is a work in progress!** This library is still very early in development. Things won't work, things will be missing, and there will be breaking changes.

## Cursor pagination
```ts
const query = db
  .selectFrom("blogPosts")
  .select(["id", "title", "body", "authorId"])
  .where("authorId", "=", 1);

const result = await executeWithCursorPagination(query, {
  perPage: 10,
  fields: [
    { expression: "title", direction: "desc" },
    { expression: "id", direction: "asc" },
  ],
  parseCursor: (cursor) => ({
    title: cursor.title,
    id: parseInt(cursor.id, 10),
  }),
});
```

### Seeking the index on later pages

Set `seek: true` on the leading sort field to bound it by the cursor value as
well (`>=` or `<=`). The keyset `OR` already implies the bound, so results do
not change, but Postgres can only use the bound as an index condition. A deep
page then seeks to the cursor instead of scanning from the start of the order.
`seek` is allowed only on the leading, non-nullable field.

### Invalid cursors

A cursor that cannot be decoded, names other fields, or that `parseCursor`
refuses throws `InvalidCursorError`, with the original error as `cause`.

## Offset pagination
```ts
const query = db
  .selectFrom("blogPosts")
  .select(["id", "title", "body", "authorId"])
  .where("authorId", "=", 1)
  .orderBy("title", "desc")
  .orderBy("id", "asc");

const result = await executeWithOffsetPagination(query, {
  perPage: 10,
  page: 1,
})
```
