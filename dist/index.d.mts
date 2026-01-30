import { StringReference, OrderByDirection, ReferenceExpression, SelectQueryBuilder } from 'kysely';

declare const SIMPLE_COLUMN_DATA_TYPES: readonly ["varchar", "char", "text", "integer", "boolean", "double precision", "decimal", "numeric", "date", "datetime", "time", "timetz", "timestamp", "timestamptz"];
type SimpleColumnDataType = (typeof SIMPLE_COLUMN_DATA_TYPES)[number];
type RequireNullableAndDataType<T> = T & ({
    nullable?: never;
    dataType?: never;
} | {
    nullable: boolean;
    dataType: SimpleColumnDataType;
});
type SortField<DB, TB extends keyof DB, O> = RequireNullableAndDataType<{
    expression: (StringReference<DB, TB> & keyof O & string) | (StringReference<DB, TB> & `${string}.${keyof O & string}`);
    direction: OrderByDirection;
    key?: keyof O & string;
}> | RequireNullableAndDataType<{
    expression: ReferenceExpression<DB, TB>;
    direction: OrderByDirection;
    key: keyof O & string;
}>;
type ExtractSortFieldKey<DB, TB extends keyof DB, O, T extends SortField<DB, TB, O>> = T["key"] extends keyof O & string ? T["key"] : T["expression"] extends keyof O & string ? T["expression"] : T["expression"] extends `${string}.${infer K}` ? K extends keyof O & string ? K : never : never;
type Fields<DB, TB extends keyof DB, O> = ReadonlyArray<Readonly<SortField<DB, TB, O>>>;
type FieldNames<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
    [TIndex in keyof T]: ExtractSortFieldKey<DB, TB, O, T[TIndex]>;
};
type EncodeCursorValues<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
    [TIndex in keyof T]: [
        ExtractSortFieldKey<DB, TB, O, T[TIndex]>,
        O[ExtractSortFieldKey<DB, TB, O, T[TIndex]>]
    ];
};
type CursorEncoder<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = (values: EncodeCursorValues<DB, TB, O, T>) => string;
type DecodedCursor<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
    [TField in ExtractSortFieldKey<DB, TB, O, T[number]>]: string;
};
type CursorDecoder<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = (cursor: string, fields: FieldNames<DB, TB, O, T>) => DecodedCursor<DB, TB, O, T>;
type ParsedCursorValues<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = {
    [TField in ExtractSortFieldKey<DB, TB, O, T[number]>]: O[TField];
};
type CursorParser<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>> = (cursor: DecodedCursor<DB, TB, O, T>) => ParsedCursorValues<DB, TB, O, T>;
type CursorPaginationResultRow<TRow, TCursorKey extends string | boolean | undefined> = TRow & {
    [K in TCursorKey extends undefined ? never : TCursorKey extends false ? never : TCursorKey extends true ? "$cursor" : TCursorKey]: string;
};
type CursorPaginationResult<TRow, TCursorKey extends string | boolean | undefined> = {
    startCursor: string | undefined;
    endCursor: string | undefined;
    hasNextPage?: boolean;
    hasPrevPage?: boolean;
    rows: CursorPaginationResultRow<TRow, TCursorKey>[];
};
declare function executeWithCursorPagination<DB, TB extends keyof DB, O, const TFields extends Fields<DB, TB, O>, TCursorKey extends string | boolean | undefined = undefined>(qb: SelectQueryBuilder<DB, TB, O>, opts: {
    perPage: number;
    after?: string;
    before?: string;
    cursorPerRow?: TCursorKey;
    fields: TFields;
    encodeCursor?: CursorEncoder<DB, TB, O, TFields>;
    decodeCursor?: CursorDecoder<DB, TB, O, TFields>;
    parseCursor: CursorParser<DB, TB, O, TFields> | {
        parse: CursorParser<DB, TB, O, TFields>;
    };
}): Promise<CursorPaginationResult<O, TCursorKey>>;
declare function defaultEncodeCursor<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>>(values: EncodeCursorValues<DB, TB, O, T>): string;
declare function defaultDecodeCursor<DB, TB extends keyof DB, O, T extends Fields<DB, TB, O>>(cursor: string, fields: FieldNames<DB, TB, O, T>): DecodedCursor<DB, TB, O, T>;

type OffsetPaginationResult<O> = {
    hasNextPage?: boolean;
    hasPrevPage?: boolean;
    rows: O[];
};
declare function executeWithOffsetPagination<O, DB, TB extends keyof DB>(qb: SelectQueryBuilder<DB, TB, O>, opts: {
    perPage: number;
    page: number;
    experimental_deferredJoinPrimaryKey?: StringReference<DB, TB>;
}): Promise<OffsetPaginationResult<O>>;

export { type CursorDecoder, type CursorEncoder, type CursorPaginationResult, type CursorParser, type Fields, type OffsetPaginationResult, SIMPLE_COLUMN_DATA_TYPES, type SimpleColumnDataType, type SortField, defaultDecodeCursor, defaultEncodeCursor, executeWithCursorPagination, executeWithOffsetPagination };
