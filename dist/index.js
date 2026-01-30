"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  SIMPLE_COLUMN_DATA_TYPES: () => SIMPLE_COLUMN_DATA_TYPES,
  defaultDecodeCursor: () => defaultDecodeCursor,
  defaultEncodeCursor: () => defaultEncodeCursor,
  executeWithCursorPagination: () => executeWithCursorPagination,
  executeWithOffsetPagination: () => executeWithOffsetPagination
});
module.exports = __toCommonJS(index_exports);

// src/cursor.ts
var import_kysely = require("kysely");
var SIMPLE_COLUMN_DATA_TYPES = [
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
  "timestamptz"
];
async function executeWithCursorPagination(qb, opts) {
  const encodeCursor = opts.encodeCursor ?? defaultEncodeCursor;
  const decodeCursor = opts.decodeCursor ?? defaultDecodeCursor;
  const parseCursor = typeof opts.parseCursor === "function" ? opts.parseCursor : opts.parseCursor.parse;
  const fields = opts.fields.map((field) => {
    let key = field.key;
    if (!key && typeof field.expression === "string") {
      const expressionParts = field.expression.split(".");
      key = expressionParts[1] ?? expressionParts[0];
    }
    if (!key) throw new Error("missing key");
    return { ...field, key };
  });
  function generateCursor(row) {
    const cursorFieldValues = fields.map(({ key }) => [
      key,
      row[key]
    ]);
    return encodeCursor(cursorFieldValues);
  }
  const fieldNames = fields.map((field) => field.key);
  const reversed = !!opts.before && !opts.after;
  function applyCursor(qb2, encoded, defaultDirection) {
    const decoded = decodeCursor(encoded, fieldNames);
    const cursor = parseCursor(decoded);
    return qb2.where(({ and, or, eb, fn, cast }) => {
      let expression;
      for (let i = fields.length - 1; i >= 0; --i) {
        const field = fields[i];
        const comparison = field.direction === defaultDirection ? ">" : "<";
        const value = cursor[field.key];
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
                  import_kysely.sql.val(value),
                  cast(import_kysely.sql.val(boundaryValue), field.dataType)
                )
              )
            ];
          } else {
            conditions = [
              eb(
                fn.coalesce(
                  field.expression,
                  cast(import_kysely.sql.val(boundaryValue), field.dataType)
                ),
                comparison,
                value
              )
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
  const nullsPosition = opts.before ? "first" : "last";
  for (const { expression, direction, nullable } of fields) {
    const dir = reversed ? direction === "asc" ? "desc" : "asc" : direction;
    if (nullable) {
      qb = qb.orderBy(
        expression,
        (ob) => dir === "asc" ? nullsPosition === "first" ? ob.asc().nullsFirst() : ob.asc().nullsLast() : nullsPosition === "first" ? ob.desc().nullsFirst() : ob.desc().nullsLast()
      );
    } else {
      qb = qb.orderBy(expression, dir);
    }
  }
  const rows = await qb.limit(opts.perPage + 1).execute();
  const hasNextPage = reversed ? void 0 : rows.length > opts.perPage;
  const hasPrevPage = !reversed ? void 0 : rows.length > opts.perPage;
  if (rows.length > opts.perPage) rows.pop();
  if (reversed) rows.reverse();
  const startRow = rows[0];
  const endRow = rows[rows.length - 1];
  const startCursor = startRow ? generateCursor(startRow) : void 0;
  const endCursor = endRow ? generateCursor(endRow) : void 0;
  return {
    startCursor,
    endCursor,
    hasNextPage,
    hasPrevPage,
    rows: rows.map((row) => {
      if (opts.cursorPerRow) {
        const cursorKey = typeof opts.cursorPerRow === "string" ? opts.cursorPerRow : "$cursor";
        row[cursorKey] = generateCursor(row);
      }
      return row;
    })
  };
}
function defaultEncodeCursor(values) {
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
function defaultDecodeCursor(cursor, fields) {
  let parsed;
  try {
    parsed = [
      ...new URLSearchParams(
        Buffer.from(cursor, "base64url").toString("utf8")
      ).entries()
    ];
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
  return Object.fromEntries(parsed);
}
var minMaxValues = {
  varchar: { min: "", max: "\uFFFF" },
  char: { min: "", max: "\uFFFF" },
  text: { min: "", max: "\uFFFF" },
  integer: { min: -2147483648, max: 2147483647 },
  boolean: { min: false, max: true },
  "double precision": { min: -17e307, max: 17e307 },
  decimal: { min: "-Infinity", max: "Infinity" },
  numeric: { min: "-Infinity", max: "Infinity" },
  date: { min: "0001-01-01", max: "9999-12-31" },
  datetime: { min: "0001-01-01 00:00:00", max: "9999-12-31 23:59:59" },
  time: { min: "00:00:00", max: "23:59:59" },
  timetz: { min: "00:00:00+00", max: "23:59:59+14" },
  timestamp: { min: "0001-01-01 00:00:00", max: "9999-12-31 23:59:59" },
  timestamptz: { min: "0001-01-01 00:00:00+00", max: "9999-12-31 23:59:59+00" }
};
function getBoundaryValue(order, dataType) {
  const direction = order === "asc" ? "max" : "min";
  if (minMaxValues[dataType]) {
    return minMaxValues[dataType][direction];
  }
  throw new Error(`Unsupported dataType: ${dataType}`);
}

// src/offset.ts
var import_kysely2 = require("kysely");
async function executeWithOffsetPagination(qb, opts) {
  qb = qb.limit(opts.perPage + 1).offset((opts.page - 1) * opts.perPage);
  const deferredJoinPrimaryKey = opts.experimental_deferredJoinPrimaryKey;
  if (deferredJoinPrimaryKey) {
    const primaryKeys = await qb.clearSelect().select((eb) => eb.ref(deferredJoinPrimaryKey).as("primaryKey")).execute().then((rows2) => rows2.map((row) => row.primaryKey));
    qb = qb.where(
      (eb) => primaryKeys.length > 0 ? eb(deferredJoinPrimaryKey, "in", primaryKeys) : eb(import_kysely2.sql`1`, "=", 0)
    ).clearOffset().clearLimit();
  }
  const rows = await qb.execute();
  const hasNextPage = rows.length > 0 ? rows.length > opts.perPage : void 0;
  const hasPrevPage = rows.length > 0 ? opts.page > 1 : void 0;
  if (rows.length > opts.perPage) {
    rows.pop();
  }
  return {
    hasNextPage,
    hasPrevPage,
    rows
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SIMPLE_COLUMN_DATA_TYPES,
  defaultDecodeCursor,
  defaultEncodeCursor,
  executeWithCursorPagination,
  executeWithOffsetPagination
});
