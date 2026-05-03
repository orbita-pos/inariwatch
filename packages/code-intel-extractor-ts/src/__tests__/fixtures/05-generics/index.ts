export function identity<T>(x: T): T {
  return x;
}

export class Box<T extends object> {
  constructor(public value: T) {}

  map<U extends object>(f: (v: T) => U): Box<U> {
    return new Box(f(this.value));
  }
}
