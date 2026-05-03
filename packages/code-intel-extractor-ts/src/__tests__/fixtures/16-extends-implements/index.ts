export interface Comparable<T> {
  compareTo(other: T): number;
}

export class BaseEntity {
  constructor(public id: string) {}
}

export class Person extends BaseEntity implements Comparable<Person> {
  constructor(id: string, public name: string) {
    super(id);
  }
  compareTo(other: Person): number {
    return this.name.localeCompare(other.name);
  }
}
