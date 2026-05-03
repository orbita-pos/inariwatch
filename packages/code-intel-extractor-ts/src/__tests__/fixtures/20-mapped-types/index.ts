export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type PartialDeep<T> = T extends object ? { [K in keyof T]?: PartialDeep<T[K]> } : T;

export interface Config {
  readonly host: string;
  readonly port: number;
}

export const sample: Mutable<Config> = { host: "localhost", port: 1 };
