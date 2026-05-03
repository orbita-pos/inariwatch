export type IsArray<T> = T extends Array<unknown> ? true : false;
export type ElementOf<T> = T extends Array<infer U> ? U : never;
export type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;

export const sample: IsArray<number[]> = true;
