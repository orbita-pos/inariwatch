export abstract class Animal {
  abstract speak(): string;

  describe(): string {
    return `An animal that says ${this.speak()}`;
  }
}

export class Dog extends Animal {
  speak(): string {
    return "woof";
  }
}
