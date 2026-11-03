import { describe, it, expect } from "vitest";
import { holdOffUpdate, updateHeldOff } from "./updateHold";

describe("holdOffUpdate", () => {
  it("holds for as long as any held work runs, and lets go when it fails", async () => {
    let finishFirst: () => void = () => {};
    const first = holdOffUpdate(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = holdOffUpdate(async () => { throw new Error("write failed"); });

    expect(updateHeldOff()).toBe(true);
    await expect(second).rejects.toThrow("write failed");
    expect(updateHeldOff()).toBe(true);
    finishFirst();
    await first;
    expect(updateHeldOff()).toBe(false);
  });
});
