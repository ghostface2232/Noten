import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../utils/noteTypes";
import type { TiptapEditorHandle } from "../components/TiptapEditor";

const refs = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "window-a" }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    refs.handlers.set(name, handler);
    return () => refs.handlers.delete(name);
  }),
}));

vi.mock("./useNotesLoader", () => ({
  sortNotes: <T,>(docs: T[]) => docs,
  setTrashedNotesCache: vi.fn(),
  syncGroupsSnapshotFromDisk: vi.fn(async () => {}),
  getNotesDir: vi.fn(async () => "/notes"),
}));

import { useWindowSync } from "./useWindowSync";

function makeDoc(id: string): NoteDoc {
  return {
    id,
    filePath: `/notes/${id}.md`,
    fileName: `Note ${id}`,
    content: id,
    isDirty: id === "a",
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderWindowSync(settleRemoteDeletedDoc: (docId: string) => Promise<boolean>) {
  const openDocument = vi.fn();
  const tiptapRef = {
    current: {
      getEditor: () => ({ storage: { documentContext: { noteId: "a" } } }),
      openDocument,
    } as unknown as TiptapEditorHandle,
  };

  const hook = renderHook(() => {
    const [docs, setDocs] = useState([makeDoc("a"), makeDoc("b")]);
    const [activeIndex, setActiveIndex] = useState(0);
    useWindowSync(
      setDocs,
      activeIndex,
      docs[activeIndex]?.id ?? null,
      tiptapRef,
      setActiveIndex,
      undefined,
      undefined,
      undefined,
      "updated-desc",
      "en",
      settleRemoteDeletedDoc,
    );
    return { docs, activeIndex };
  });
  return { ...hook, openDocument };
}

beforeEach(() => {
  refs.handlers.clear();
});

describe("useWindowSync — remote deletion", () => {
  it("keeps the document live until its local autosave state is settled", async () => {
    let finish!: (value: boolean) => void;
    const settle = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderWindowSync(settle);
    await waitFor(() => expect(refs.handlers.has("doc-deleted")).toBe(true));

    act(() => {
      refs.handlers.get("doc-deleted")?.({
        payload: { sourceWindow: "window-b", docId: "a" },
      });
    });
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["a", "b"]);

    await act(async () => { finish(true); });
    await waitFor(() => expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]));
    expect(settle).toHaveBeenCalledWith("a");
  });

  it("still applies deletion when preserving the local copy fails", async () => {
    const settle = vi.fn(async () => { throw new Error("preservation failed"); });
    const { result } = renderWindowSync(settle);
    await waitFor(() => expect(refs.handlers.has("doc-deleted")).toBe(true));

    act(() => {
      refs.handlers.get("doc-deleted")?.({
        payload: { sourceWindow: "window-b", docId: "a" },
      });
    });

    await waitFor(() => expect(settle).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]));
  });
});
