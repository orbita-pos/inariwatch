export class Counter {
  private value = 0;

  increment(): number {
    this.value++;
    return this.value;
  }

  static zero(): Counter {
    return new Counter();
  }
}
