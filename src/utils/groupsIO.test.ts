import { describe, it, expect } from "vitest";
import { genOrderKeyAfter, genOrderKeyBefore, genOrderKeyBetween, genSpreadOrderKeys, isOrderKeyBetween } from "./groupsIO";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomKey(maxLen = 4): string {
  const len = 1 + Math.floor(Math.random() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

describe("fractional order keys", () => {
  it("genOrderKeyBetween returns a key strictly between adjacent digits", () => {
    // The reported case: 'h' and 'i' are adjacent, so the old code appended
    // the mid digit to a's prefix and threw away a's "z" suffix, producing
    // "hi" — which sorts BEFORE "hz" and silently misplaced the dragged note.
    const key = genOrderKeyBetween("hz", "i");
    expect(key > "hz").toBe(true);
    expect(key < "i").toBe(true);
  });

  it("genOrderKeyBetween returns a key strictly between when a is a prefix of b", () => {
    const key = genOrderKeyBetween("o", "o0sm");
    expect(key > "o").toBe(true);
    expect(key < "o0sm").toBe(true);
  });

  it("genOrderKeyBefore shrinks rather than grows when the last digit is minimal", () => {
    // "4l0" cannot have its last digit decremented; dropping it gives "4l",
    // which sorts before. The old code appended and returned "4l0i" — after.
    const key = genOrderKeyBefore("4l0");
    expect(key < "4l0").toBe(true);
  });

  it("holds the ordering invariant across random key pairs", () => {
    const failures: string[][] = [];
    for (let n = 0; n < 20_000; n++) {
      const a = randomKey();
      const b = randomKey();
      if (a >= b) continue;
      // Known-unsatisfiable: no key fits between x and x + "0".
      if (b === `${a}0`) continue;
      const mid = genOrderKeyBetween(a, b);
      if (!(a < mid && mid < b)) failures.push([a, mid, b]);
    }
    expect(failures).toEqual([]);
  });

  it("spreads fixed-width ascending keys, none a prefix of another", () => {
    for (const count of [0, 1, 2, 17, 36, 1295, 1296, 3000]) {
      const keys = genSpreadOrderKeys(count);
      expect(keys).toHaveLength(count);
      for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
      expect(new Set(keys.map((k) => k.length)).size).toBeLessThanOrEqual(1);
      // Room before the first key, so the next drag to the top is representable.
      if (count > 0) expect(isOrderKeyBetween(genOrderKeyBefore(keys[0]), undefined, { orderKey: keys[0] })).toBe(true);
    }
  });

  it("isOrderKeyBetween compares like the group comparator", () => {
    expect(isOrderKeyBetween("0i", undefined, { orderKey: "0" })).toBe(false);
    expect(isOrderKeyBetween("b", { orderKey: "a" }, { orderKey: "c" })).toBe(true);
    expect(isOrderKeyBetween("a", { orderKey: "a" }, undefined)).toBe(false);
    expect(isOrderKeyBetween("a", undefined, { orderKey: undefined })).toBe(false);
    expect(isOrderKeyBetween("a", { orderKey: undefined }, undefined)).toBe(true);
  });

  it("genOrderKeyAfter and genOrderKeyBefore stay on their side of the input", () => {
    const afterFailures: string[][] = [];
    const beforeFailures: string[][] = [];
    for (let n = 0; n < 20_000; n++) {
      const x = randomKey();
      const after = genOrderKeyAfter(x);
      if (!(after > x)) afterFailures.push([x, after]);
      // Known-unsatisfiable: nothing sorts before a bare minimum digit.
      if (x === "0") continue;
      const before = genOrderKeyBefore(x);
      if (!(before < x)) beforeFailures.push([x, before]);
    }
    expect(afterFailures).toEqual([]);
    expect(beforeFailures).toEqual([]);
  });
});
