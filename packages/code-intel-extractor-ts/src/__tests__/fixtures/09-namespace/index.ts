export namespace Math2 {
  export const PI = 3.14;
  export function double(x: number): number {
    return x * 2;
  }
  export namespace Inner {
    export function triple(x: number): number {
      return x * 3;
    }
  }
}
