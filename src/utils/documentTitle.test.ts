import { describe, it, expect } from "vitest";
import { keepManualTitle } from "./documentTitle";

describe("keepManualTitle", () => {
  it("keeps the live manual title over a read that predates the rename", () => {
    const merged = keepManualTitle(
      { fileName: "Named", customName: true },
      { fileName: "Auto title", customName: undefined, pinned: true },
    );
    expect(merged).toEqual({ fileName: "Named", customName: true, pinned: true });
  });

  it("defers to a read that carries a manual title of its own", () => {
    const incoming = { fileName: "Renamed elsewhere", customName: true };
    expect(keepManualTitle({ fileName: "Named", customName: true }, incoming)).toBe(incoming);
  });

  it("defers to the read when the live doc has no manual title", () => {
    const auto = { fileName: "Auto title" };
    const named = { fileName: "Named", customName: true };
    expect(keepManualTitle({ fileName: "Old" }, auto)).toBe(auto);
    expect(keepManualTitle({ fileName: "Old" }, named)).toBe(named);
  });
});
