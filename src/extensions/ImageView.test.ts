import { describe, it, expect } from "vitest";
import { shouldRefreshImageSelection } from "./ImageView";

describe("shouldRefreshImageSelection", () => {
  it("skips the typing hot path: nothing selected and nothing changed", () => {
    expect(
      shouldRefreshImageSelection(
        { pos: null, readonly: false },
        { pos: null, readonly: false },
      ),
    ).toBe(false);
  });

  it("refreshes when an image becomes selected", () => {
    expect(
      shouldRefreshImageSelection(
        { pos: null, readonly: false },
        { pos: 5, readonly: false },
      ),
    ).toBe(true);
  });

  it("refreshes when an image is deselected", () => {
    expect(
      shouldRefreshImageSelection(
        { pos: 5, readonly: false },
        { pos: null, readonly: false },
      ),
    ).toBe(true);
  });

  it("refreshes when the selected image position shifts (edit above it)", () => {
    expect(
      shouldRefreshImageSelection(
        { pos: 5, readonly: false },
        { pos: 8, readonly: false },
      ),
    ).toBe(true);
  });

  it("keeps refreshing while an image stays selected (selectNode-skip guard)", () => {
    // Same position, no readonly change, but an image is selected: still refresh
    // so a transaction where PM skipped selectNode/deselectNode can't strand the
    // outline in the wrong state.
    expect(
      shouldRefreshImageSelection(
        { pos: 5, readonly: false },
        { pos: 5, readonly: false },
      ),
    ).toBe(true);
  });

  it("refreshes when readonly toggles even with no selection", () => {
    expect(
      shouldRefreshImageSelection(
        { pos: null, readonly: false },
        { pos: null, readonly: true },
      ),
    ).toBe(true);
  });
});
