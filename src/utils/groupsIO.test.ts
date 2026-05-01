import { describe, expect, it } from "vitest";
import { genOrderKeyBetween, mergeStoredGroups, type StoredGroup } from "./groupsIO";

function group(overrides: Partial<StoredGroup>): StoredGroup {
  return {
    id: "g",
    name: "Group",
    orderKey: "m",
    orderUpdatedAt: 1,
    updatedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

describe("groupsIO.mergeStoredGroups", () => {
  it("uses updatedAt for names and orderUpdatedAt for order independently", () => {
    const a = group({ id: "g", name: "Old name", orderKey: "a", updatedAt: 10, orderUpdatedAt: 20 });
    const b = group({ id: "g", name: "New name", orderKey: "z", updatedAt: 30, orderUpdatedAt: 5 });

    expect(mergeStoredGroups([a], [b])).toEqual([
      expect.objectContaining({ id: "g", name: "New name", orderKey: "a" }),
    ]);
  });

  it("keeps the newest tombstone regardless of name winner", () => {
    const a = group({ id: "g", name: "Winner", updatedAt: 50, deletedAt: 10 });
    const b = group({ id: "g", name: "Loser", updatedAt: 20, deletedAt: 100 });

    expect(mergeStoredGroups([a], [b])[0]).toEqual(expect.objectContaining({
      name: "Winner",
      deletedAt: 100,
    }));
  });

  it("is symmetric", () => {
    const a = group({ id: "a", name: "A", orderKey: "a" });
    const b = group({ id: "a", name: "B", updatedAt: 2, orderKey: "b", orderUpdatedAt: 2 });

    expect(mergeStoredGroups([a], [b])).toEqual(mergeStoredGroups([b], [a]));
  });
});

describe("genOrderKeyBetween", () => {
  it("creates lexicographic keys between neighbors", () => {
    const key = genOrderKeyBetween("a", "z");
    expect(key > "a").toBe(true);
    expect(key < "z").toBe(true);
  });

  it("supports repeated insertion into the same gap", () => {
    let left = "a";
    for (let i = 0; i < 20; i += 1) {
      const key = genOrderKeyBetween(left, null);
      expect(key > left).toBe(true);
      left = key;
    }
  });
});
