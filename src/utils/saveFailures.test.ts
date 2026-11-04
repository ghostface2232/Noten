import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isSaveFailing,
  markSaveFailed,
  markSaveSettled,
  settleSavesWithoutPending,
  subscribeSaveFailures,
} from "./saveFailures";

afterEach(() => settleSavesWithoutPending(() => false));

describe("saveFailures", () => {
  it("stays failing until every failed note has settled", () => {
    markSaveFailed("a");
    markSaveFailed("b");
    markSaveSettled("a");
    expect(isSaveFailing()).toBe(true);

    markSaveSettled("b");
    expect(isSaveFailing()).toBe(false);
  });

  it("is not settled by a save of another note", () => {
    markSaveFailed("a");
    markSaveSettled("other");

    expect(isSaveFailing()).toBe(true);
  });

  it("forgets a note with nothing left pending", () => {
    markSaveFailed("kept");
    markSaveFailed("deleted");

    settleSavesWithoutPending((id) => id === "kept");
    expect(isSaveFailing()).toBe(true);

    settleSavesWithoutPending(() => false);
    expect(isSaveFailing()).toBe(false);
  });

  it("tells a subscriber only when the answer changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSaveFailures(listener);

    markSaveFailed("a");
    markSaveFailed("b");
    expect(listener).toHaveBeenCalledTimes(1);

    markSaveSettled("a");
    markSaveSettled("b");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    markSaveFailed("c");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
