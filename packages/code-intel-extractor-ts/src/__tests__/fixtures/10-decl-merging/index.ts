// Declaration merging — interface + namespace sharing the same FQN.
// Schema's UNIQUE (repo_id, fqn, kind) accommodates this; the extractor
// emits one row for each.

export interface Vehicle {
  wheels: number;
}

export namespace Vehicle {
  export const DEFAULT_WHEELS = 4;
  export function withWheels(n: number): Vehicle {
    return { wheels: n };
  }
}
