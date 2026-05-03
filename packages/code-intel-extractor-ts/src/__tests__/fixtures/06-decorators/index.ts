function readonly(_target: object, _key: string): void {
  // marker decorator
}

export class Point {
  @readonly
  x = 0;

  @readonly
  y = 0;
}
