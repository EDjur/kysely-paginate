# kysely-paginate

## 1.1.0

### Improvements

- **Sargable nullable keyset pagination.** Null handling in the cursor `WHERE`
  clause now uses `col <cmp> val OR col IS NULL` / `col IS NOT NULL` on the bare
  column instead of `COALESCE(col, <sentinel>) <cmp> val`. The column is no
  longer wrapped in a function call, so a b-tree index on it stays usable
  (the old form forced a sequential scan + sort). Paging behaviour (NULLS LAST
  ordering, forward/backward) is unchanged and existing cursors stay valid.
- `dataType` on a nullable sort field is now **optional** — it only existed to
  pick the COALESCE sentinel, which is gone. The per-type sentinel table
  (`minMaxValues` / `getBoundaryValue`) was removed, which also removes the
  latent sentinel-collision edge case.

### Added

- `getCursorEncoder({ fields, encodeCursor? })` — builds a function that encodes
  a single row's cursor (the same value `cursorPerRow` would stamp). Lets
  "find the page containing row X" lookups encode just the anchor row instead
  of paying `cursorPerRow`'s per-row encode across the whole scan.

### Internal

- Field-key derivation unified into a single `resolveFieldKey` helper shared by
  `executeWithCursorPagination` and `getCursorEncoder`.

## 1.0.0

### Breaking Changes

- Upgraded all dependencies to latest versions
- Now requires Node.js 16.14.0 or higher
- Peer dependency `kysely` remains compatible with all versions

### Dependencies

- `zod` upgraded from 3.x to 4.x
- `typescript` upgraded to 5.9.x
- All other dev dependencies upgraded to latest versions

### Internal

- Migrated ESLint config to flat config format (ESLint 9)
- Migrated Vitest config to v4 format
- Added `vitest.config.ts` for test configuration

## 0.0.1

### Patch Changes

Fork repo from kysely-paginate

- Add support for nullable field pagination
