import { describe, it, expect, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { resolveRenderableImageSource } from "../utils/imageAssetUtils";
import {
  createImageNodeView,
  refreshImageNodeViewSources,
  shouldAssignRenderableImageSource,
  shouldRefreshImageSelection,
  shouldSyncImageSource,
} from "./ImageView";

vi.mock("../utils/imageAssetUtils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/imageAssetUtils")>();
  return {
    ...actual,
    resolveRenderableImageSource: vi.fn(() => null),
  };
});

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

describe("image source synchronization", () => {
  const context = { noteId: "note", filePath: "/notes/note.md" };

  it("skips resolving an unchanged node source", () => {
    expect(shouldSyncImageSource(
      ".assets/note/image.png",
      ".assets/note/image.png",
      context,
      context,
    )).toBe(false);
  });

  it("resolves a changed node source", () => {
    expect(shouldSyncImageSource(
      ".assets/note/old.png",
      ".assets/note/new.png",
      context,
      context,
    )).toBe(true);
  });

  it("resolves an unchanged relative source against a changed document context", () => {
    const src = ".assets/note/image.png";
    expect(shouldSyncImageSource(
      src,
      src,
      context,
      { noteId: "note", filePath: "/other-notes/note.md" },
    )).toBe(true);
    expect(shouldSyncImageSource(
      src,
      src,
      context,
      { noteId: "other-note", filePath: context.filePath },
    )).toBe(true);
  });

  it("refreshes a reused node view after only its document context changes", () => {
    const documentContext = { noteId: "note", filePath: "/notes/note.md" };
    const editor = {
      storage: {
        documentContext,
        readonlyGuard: { readonly: false },
      },
      state: { selection: {} },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Editor;
    const node = {
      attrs: { src: ".assets/note/image.png" },
      nodeSize: 1,
      type: { name: "image" },
    };
    const nodeView = createImageNodeView(editor)({
      node,
      getPos: () => 0,
      HTMLAttributes: node.attrs,
    });
    const resolveMock = vi.mocked(resolveRenderableImageSource);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    documentContext.filePath = "/other-notes/note.md";
    refreshImageNodeViewSources(editor);

    expect(resolveMock).toHaveBeenCalledTimes(2);
    expect(resolveMock).toHaveBeenLastCalledWith(node.attrs.src, {
      noteId: "note",
      filePath: "/other-notes/note.md",
    });
    nodeView.destroy?.();
  });

  it("skips assigning an unchanged resolved source to the img element", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    expect(shouldAssignRenderableImageSource(dataUrl, dataUrl)).toBe(false);
  });

  it("updates or clears the img element when the resolved source changes", () => {
    expect(shouldAssignRenderableImageSource(null, "data:image/png;base64,AAAA")).toBe(true);
    expect(shouldAssignRenderableImageSource("data:image/png;base64,AAAA", null)).toBe(true);
  });
});
