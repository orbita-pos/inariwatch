import helperDefault, { helperA, helperB as renamed } from "./helpers";
import * as ns from "./helpers";

export function callAll(): number {
  return helperA() + renamed() + ns.helperA() + (helperDefault().length);
}
