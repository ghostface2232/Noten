import { useCallback, useMemo, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc, TrashedNote } from "../utils/noteTypes";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { createLibraryStore, type LibrarySnapshot, type LibraryUpdater } from "../utils/libraryStore";

const refs = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  diskBodies: new Map<string, string>(),
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

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(async (path: string) => {
    const body = refs.diskBodies.get(path);
    if (body == null) throw new Error("os error 2");
    return body;
  }),
}));

vi.mock("./useNotesLoader", () => ({
  sortNotes: <T,>(docs: T[]) => docs,
  setTrashedNotesCache: vi.fn(),
  syncGroupsSnapshotFromDisk: vi.fn(async () => {}),
  getNotesDir: vi.fn(async () => "/notes"),
}));

import { useWindowSync, emitDocUpdated, resetDocBodyClocks, resetGroupSyncClocks, emitGroupsDelta, INLINE_BODY_MAX_CHARS } from "./useWindowSync";
import { emit } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getKnownDiskContent, resetKnownDiskContent, setKnownDiskContent } from "../utils/conflictBackup";
import type { NoteGroup } from "../utils/noteTypes";

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

function makeTrashed(id: string, trashedAt: number): TrashedNote {
  return {
    id,
    fileName: `Note ${id}`,
    originalFilePath: `/notes/${id}.md`,
    trashFilePath: `/notes/.trash/${id}.md`,
    trashedAt,
    groupId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderWindowSync(
  settleRemoteDeletedDoc: (docId: string) => Promise<boolean>,
  initialDocs: NoteDoc[] = [makeDoc("a"), makeDoc("b")],
  initialTrashed: TrashedNote[] = [],
  initialGroups: NoteGroup[] = [],
) {
  const openDocument = vi.fn();
  const onActiveDocChanged = vi.fn();
  const tiptapRef = {
    current: {
      getEditor: () => ({ storage: { documentContext: { noteId: "a" } } }),
      openDocument,
    } as unknown as TiptapEditorHandle,
  };

  const hook = renderHook(() => {
    // A private canonical store stands in for useNotesLoader's adapter: the
    // hook must express every remote change as one store updater.
    const store = useMemo(() => createLibraryStore({
      docs: initialDocs,
      groups: initialGroups,
      trashedNotes: initialTrashed,
      activeNoteId: initialDocs[0]?.id ?? null,
      notesDirectory: "/notes",
    }), []);
    const [snapshot, setSnapshot] = useState<LibrarySnapshot>(() => store.getSnapshot());
    const commitRemote = useCallback((update: LibraryUpdater) => {
      const before = store.getSnapshot();
      const committed = store.commit(update, "remote");
      if (committed === before) return null;
      setSnapshot(committed);
      return committed;
    }, [store]);
    const docs = snapshot.docs as NoteDoc[];
    const activeIndex = snapshot.activeNoteId
      ? Math.max(docs.findIndex((doc) => doc.id === snapshot.activeNoteId), 0)
      : 0;
    useWindowSync(
      commitRemote,
      docs[activeIndex]?.id ?? null,
      tiptapRef,
      onActiveDocChanged,
      "updated-desc",
      "en",
      settleRemoteDeletedDoc,
    );
    return { docs, activeIndex, snapshot };
  });
  return { ...hook, openDocument, onActiveDocChanged };
}

beforeEach(() => {
  refs.handlers.clear();
  refs.diskBodies.clear();
  vi.mocked(emit).mockClear();
  vi.mocked(readTextFile).mockClear();
  resetDocBodyClocks();
  resetGroupSyncClocks();
  resetKnownDiskContent();
});

describe("useWindowSync — doc-renamed carries customName", () => {
  // customName is what the three empty-note prunes read as "the user named
  // this, never auto-delete it", and those prunes delete permanently. Taking
  // only the title from a peer's rename left a just-named empty note looking
  // auto-titled here until its sidecar arrived — and switching notes before
  // that deleted it on every synced machine.
  it("adopts the peer's manual-title flag along with the title", async () => {
    const { result } = renderWindowSync(async () => true, [
      { ...makeDoc("a"), content: "", isDirty: false },
      makeDoc("b"),
    ]);
    await waitFor(() => expect(refs.handlers.has("doc-renamed")).toBe(true));

    act(() => {
      refs.handlers.get("doc-renamed")?.({
        payload: {
          sourceWindow: "window-b",
          docId: "a",
          oldFilePath: "/notes/a.md",
          newFilePath: "/notes/a.md",
          newFileName: "Shopping list",
          customName: true,
        },
      });
    });

    expect(result.current.docs.find((doc) => doc.id === "a")).toMatchObject({
      fileName: "Shopping list",
      customName: true,
    });
  });
});

describe("useWindowSync — remote body update", () => {
  it("updates content without letting a delayed body event overwrite the title", async () => {
    const newerMetadata = {
      ...makeDoc("b"),
      fileName: "Newest sidecar title",
      updatedAt: 10_000,
    };
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), newerMetadata]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: {
          sourceWindow: "window-b",
          docId: "b",
          content: "remote body",
          updatedAt: 9000,
          // Older app versions included a title in this event. It must remain
          // outside the body event's ownership even when present on the wire.
          fileName: "Stale event title",
        },
      });
    });

    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({
      content: "remote body",
      fileName: "Newest sidecar title",
      updatedAt: 10_000,
    });
  });
  it("ignores a body event that predates a body this window already saved", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    // This window persisted "b" at 9000 and broadcast it. The doc's own
    // updatedAt is not the guard here — a peer body from BEFORE that save
    // arriving late must not roll our newer body back.
    act(() => { emitDocUpdated("b", "/notes/b.md", "our newer body", 9000); });
    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", content: "older peer body", updatedAt: 8000 },
      });
    });

    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({ content: "b" });
  });

  it("ignores a body event delivered out of order after a newer peer body", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    // Two peers saved the same note; their events reach this window in the
    // wrong order. Applying the loser would leave content and updatedAt
    // describing different revisions, and the next local save would write the
    // older body back over the newer one.
    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-c", docId: "b", content: "newest body", updatedAt: 5000 },
      });
    });
    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", content: "older body", updatedAt: 4000 },
      });
    });

    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({
      content: "newest body",
      updatedAt: 5000,
    });
  });

  it("applies a body event that is newer than the last one seen for that doc", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", content: "first", updatedAt: 4000 },
      });
    });
    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", content: "second", updatedAt: 5000 },
      });
    });

    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({
      content: "second",
      updatedAt: 5000,
    });
  });
});

// The peer emits only after its durable write, so an adopted body is what the
// file holds. Without a seed, this window's next save of that note compared the
// disk against the pre-handoff baseline and wrote a spurious .conflicts copy of
// the body it already had in memory.
describe("useWindowSync — remote body seeds the conflict baseline", () => {
  it("seeds an adopted inline body", async () => {
    setKnownDiskContent("/notes/b.md", "b");
    renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/b.md", content: "peer body", updatedAt: 4000 },
      });
    });

    expect(getKnownDiskContent("/notes/b.md")).toBe("peer body");
  });

  it("seeds an adopted body read from disk", async () => {
    const large = "y".repeat(INLINE_BODY_MAX_CHARS + 1);
    renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));
    refs.diskBodies.set("/notes/b.md", large);

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/b.md", updatedAt: 4000 },
      });
    });

    await waitFor(() => expect(getKnownDiskContent("/notes/b.md")).toBe(large));
  });

  it("does not seed a body the dirty doc declined", async () => {
    // makeDoc("a") is dirty. Seeding the declined body would tell the next
    // save that disk and baseline agree, and the peer's version would be
    // overwritten with no .conflicts copy.
    setKnownDiskContent("/notes/a.md", "a");
    renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "a", filePath: "/notes/a.md", content: "peer body", updatedAt: 4000 },
      });
    });

    expect(getKnownDiskContent("/notes/a.md")).toBe("a");
  });

  it("does not seed the new path after a rename moved the note", async () => {
    const renamed = { ...makeDoc("b"), filePath: "/notes/renamed.md" };
    renderWindowSync(async () => true, [makeDoc("a"), renamed]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/b.md", content: "peer body", updatedAt: 4000 },
      });
    });

    expect(getKnownDiskContent("/notes/renamed.md")).toBeUndefined();
    expect(getKnownDiskContent("/notes/b.md")).toBeUndefined();
  });
});

// Autosave broadcasts every body save. Carrying a large body inline pushed it
// through IPC to every window (the sender's own listener included) once a
// second while typing; above the threshold receivers read the saved file.
describe("useWindowSync — large body updates go through disk", () => {
  const large = "x".repeat(INLINE_BODY_MAX_CHARS + 1);

  it("carries a small body inline", () => {
    emitDocUpdated("b", "/notes/b.md", "small", 4000);
    expect(vi.mocked(emit)).toHaveBeenCalledWith("doc-updated", expect.objectContaining({
      docId: "b", filePath: "/notes/b.md", content: "small", updatedAt: 4000,
    }));
  });

  it("leaves a large body off the event", () => {
    emitDocUpdated("b", "/notes/b.md", large, 4000);
    const payload = vi.mocked(emit).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({ docId: "b", filePath: "/notes/b.md", updatedAt: 4000 });
    expect(payload).not.toHaveProperty("content");
  });

  it("reads a body-less update from the file the sender wrote", async () => {
    const { result, openDocument } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));
    refs.diskBodies.set("/notes/b.md", large);

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/b.md", updatedAt: 4000 },
      });
    });

    await waitFor(() => expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({
      content: large,
      updatedAt: 4000,
    }));
    expect(openDocument).not.toHaveBeenCalled();
  });

  it("drops a disk read overtaken by a newer inline body", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));
    let release!: (body: string) => void;
    vi.mocked(readTextFile).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/b.md", updatedAt: 4000 },
      });
    });
    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-c", docId: "b", filePath: "/notes/b.md", content: "newer", updatedAt: 5000 },
      });
    });
    // The read started before window-c's write and returns the older body.
    await act(async () => { release("older from disk"); });

    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({
      content: "newer",
      updatedAt: 5000,
    });
  });

  it("opens a large body read from disk in the editor when the doc is active", async () => {
    const clean = { ...makeDoc("a"), isDirty: false };
    const { openDocument } = renderWindowSync(async () => true, [clean, makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));
    refs.diskBodies.set("/notes/a.md", large);

    act(() => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "a", filePath: "/notes/a.md", updatedAt: 4000 },
      });
    });

    await waitFor(() => expect(openDocument).toHaveBeenCalledWith(expect.objectContaining({
      noteId: "a", markdown: large,
    })));
  });

  it("does not overwrite a doc that became dirty during the read", async () => {
    // makeDoc("a") is dirty: the user is typing in it.
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));
    refs.diskBodies.set("/notes/a.md", large);

    await act(async () => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "a", filePath: "/notes/a.md", updatedAt: 4000 },
      });
    });

    expect(readTextFile).toHaveBeenCalledWith("/notes/a.md");
    expect(result.current.docs.find((doc) => doc.id === "a")).toMatchObject({ content: "a", isDirty: true });
  });

  it("leaves the doc alone when the read fails", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    await act(async () => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-b", docId: "b", filePath: "/notes/missing.md", updatedAt: 4000 },
      });
    });

    expect(readTextFile).toHaveBeenCalledWith("/notes/missing.md");
    expect(result.current.docs.find((doc) => doc.id === "b")).toMatchObject({ content: "b" });
  });

  it("does not read at all for its own broadcast", async () => {
    renderWindowSync(async () => true, [makeDoc("a"), makeDoc("b")]);
    await waitFor(() => expect(refs.handlers.has("doc-updated")).toBe(true));

    await act(async () => {
      refs.handlers.get("doc-updated")?.({
        payload: { sourceWindow: "window-a", docId: "b", filePath: "/notes/b.md", updatedAt: 4000 },
      });
    });

    expect(readTextFile).not.toHaveBeenCalled();
  });
});

describe("useWindowSync — remote deletion", () => {
  it("removes the live document immediately after synchronous preservation capture", async () => {
    let finish!: (value: boolean) => void;
    const settle = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderWindowSync(settle);
    await waitFor(() => expect(refs.handlers.has("doc-deleted")).toBe(true));

    act(() => {
      refs.handlers.get("doc-deleted")?.({
        payload: { sourceWindow: "window-b", docId: "a" },
      });
    });
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(settle).toHaveBeenCalledWith("a");

    await act(async () => { finish(true); });
    await waitFor(() => expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]));
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

describe("useWindowSync — last-note replacement", () => {
  it("activates a replacement that arrives after the peer removed its last note", async () => {
    const settle = vi.fn(async () => true);
    const { result, openDocument, onActiveDocChanged } = renderWindowSync(settle, [makeDoc("a")]);
    await waitFor(() => expect(refs.handlers.has("doc-created")).toBe(true));

    act(() => {
      refs.handlers.get("doc-deleted")?.({
        payload: { sourceWindow: "window-b", docId: "a" },
      });
    });
    expect(result.current.docs).toEqual([]);

    const replacement = makeDoc("b");
    act(() => {
      refs.handlers.get("doc-created")?.({
        payload: { sourceWindow: "window-b", doc: replacement },
      });
    });

    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(result.current.activeIndex).toBe(0);
    expect(openDocument).toHaveBeenLastCalledWith({
      noteId: "b",
      filePath: replacement.filePath,
      markdown: replacement.content,
      reason: "window-sync",
    });
    expect(onActiveDocChanged).toHaveBeenLastCalledWith({
      filePath: replacement.filePath,
      content: replacement.content,
    });
  });

  it("switches to a replacement that arrives before the deletion event", async () => {
    const settle = vi.fn(async () => true);
    const { result, openDocument } = renderWindowSync(settle, [makeDoc("a")]);
    await waitFor(() => expect(refs.handlers.has("doc-created")).toBe(true));

    const replacement = makeDoc("b");
    act(() => {
      refs.handlers.get("doc-created")?.({
        payload: { sourceWindow: "window-b", doc: replacement },
      });
    });
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["a", "b"]);

    act(() => {
      refs.handlers.get("doc-deleted")?.({
        payload: { sourceWindow: "window-b", docId: "a" },
      });
    });

    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(result.current.activeIndex).toBe(0);
    expect(openDocument).toHaveBeenLastCalledWith({
      noteId: "b",
      filePath: replacement.filePath,
      markdown: replacement.content,
      reason: "window-sync",
    });
  });
});

describe("useWindowSync — trash changes", () => {
  it("keeps an entry this window trashed while a peer emptied the trash it could see", async () => {
    // The peer purged a and b; this window trashed c in the meantime, and c's
    // file is in .trash on disk. A whole-array broadcast used to drop it here.
    const { result } = renderWindowSync(
      async () => true,
      [makeDoc("a")],
      [makeTrashed("a", 100), makeTrashed("b", 200), makeTrashed("c", 300)],
    );
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [], removed: [{ id: "a", trashedAt: 100 }, { id: "b", trashedAt: 200 }] },
      });
    });

    expect(result.current.snapshot.trashedNotes.map((note) => note.id)).toEqual(["c"]);
  });

  it("appends a peer's newly trashed entries without touching the local ones", async () => {
    const { result } = renderWindowSync(
      async () => true,
      [makeDoc("a")],
      [makeTrashed("local", 100)],
    );
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [makeTrashed("peer", 200)], removed: [] },
      });
    });

    expect(result.current.snapshot.trashedNotes.map((note) => note.id)).toEqual(["local", "peer"]);
  });

  it("takes the newer trashedAt when a peer re-trashed an entry this window already holds", async () => {
    const { result } = renderWindowSync(
      async () => true,
      [makeDoc("a")],
      [makeTrashed("x", 100)],
    );
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [makeTrashed("x", 500)], removed: [] },
      });
    });

    expect(result.current.snapshot.trashedNotes).toMatchObject([{ id: "x", trashedAt: 500 }]);
  });

  it("ignores a change that would not move anything", async () => {
    const { result } = renderWindowSync(
      async () => true,
      [makeDoc("a")],
      [makeTrashed("x", 100)],
    );
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));
    const before = result.current.snapshot;

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [makeTrashed("x", 50)], removed: [{ id: "gone", trashedAt: 1 }] },
      });
    });

    expect(result.current.snapshot).toBe(before);
  });

  it("keeps a re-trashed entry when the restore that preceded it arrives late", async () => {
    // A restored x@100 and trashed it again as x@200. The re-trash reaches this
    // window first; the late restore names the OLD incarnation and must not
    // delete the newer one.
    const { result } = renderWindowSync(async () => true, [makeDoc("a")], []);
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [makeTrashed("x", 200)], removed: [] },
      });
    });
    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [], removed: [{ id: "x", trashedAt: 100 }] },
      });
    });

    expect(result.current.snapshot.trashedNotes).toMatchObject([{ id: "x", trashedAt: 200 }]);
  });

  it("removes the entry when the removal names the incarnation this window holds", async () => {
    const { result } = renderWindowSync(async () => true, [makeDoc("a")], [makeTrashed("x", 200)]);
    await waitFor(() => expect(refs.handlers.has("trash-updated")).toBe(true));

    act(() => {
      refs.handlers.get("trash-updated")?.({
        payload: { sourceWindow: "window-b", added: [], removed: [{ id: "x", trashedAt: 200 }] },
      });
    });

    expect(result.current.snapshot.trashedNotes).toEqual([]);
  });
});

describe("useWindowSync — groups delta", () => {
  const group = (id: string, overrides: Partial<NoteGroup> = {}): NoteGroup => ({
    id,
    name: id.toUpperCase(),
    noteIds: [],
    collapsed: false,
    createdAt: 1000,
    orderKey: "m",
    orderUpdatedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  const deliver = (payload: Record<string, unknown>) => {
    refs.handlers.get("groups-updated")?.({
      payload: { sourceWindow: "window-b", upserted: [], removedIds: [], membership: [], ...payload },
    });
  };

  it("a concurrent local rename and a local group survive a peer delta", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [
      group("g1", { name: "Renamed locally", updatedAt: 5000 }),
      group("g2"),
    ]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    // Peer renamed g1 at an OLDER stamp and does not mention g2 at all.
    act(() => deliver({ upserted: [{ id: "g1", name: "Peer name", createdAt: 1000, orderKey: "m", orderUpdatedAt: 1000, updatedAt: 3000 }] }));

    const groups = hook.result.current.snapshot.groups;
    expect(groups.find((g) => g.id === "g1")?.name).toBe("Renamed locally");
    expect(groups.some((g) => g.id === "g2")).toBe(true);
  });

  it("adopts a newer peer rename and orderKey by their own clocks", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [group("g1")]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({ upserted: [{ id: "g1", name: "Peer name", createdAt: 1000, orderKey: "x", orderUpdatedAt: 4000, updatedAt: 4000 }] }));

    const g1 = hook.result.current.snapshot.groups.find((g) => g.id === "g1");
    expect(g1?.name).toBe("Peer name");
    expect(g1?.orderKey).toBe("x");
  });

  it("a removal retires the group even when its upsert arrives later", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [group("g1")]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({ removedIds: ["g1"] }));
    // Out-of-order: the (older) creation/rename upsert arrives after the delete.
    act(() => deliver({ upserted: [{ id: "g1", name: "Zombie", createdAt: 900, orderKey: "m", orderUpdatedAt: 900, updatedAt: 900 }] }));

    expect(hook.result.current.snapshot.groups.some((g) => g.id === "g1")).toBe(false);
  });

  it("a duplicate delivery is a no-op", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [group("g1")]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    const payload = { membership: [{ noteId: "a", groupId: "g1", at: 2000 }] };
    act(() => deliver(payload));
    const after = hook.result.current.snapshot;
    expect(after.groups.find((g) => g.id === "g1")?.noteIds).toEqual(["a"]);
    act(() => deliver(payload));
    expect(hook.result.current.snapshot).toBe(after);
  });

  it("membership ops apply by clock: an older op loses, a newer one wins", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [
      group("g1", { noteIds: ["a"] }),
      group("g2"),
    ]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({ membership: [{ noteId: "a", groupId: "g2", at: 3000 }] }));
    expect(hook.result.current.snapshot.groups.find((g) => g.id === "g2")?.noteIds).toEqual(["a"]);

    // A delayed op with an older stamp must not move the note back.
    act(() => deliver({ membership: [{ noteId: "a", groupId: "g1", at: 2500 }] }));
    expect(hook.result.current.snapshot.groups.find((g) => g.id === "g2")?.noteIds).toEqual(["a"]);
  });

  it("a local emit's own stamps beat a late peer op", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [group("g1"), group("g2")]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    // This window moved a into g2 at t=5000 (self-record at emit time).
    emitGroupsDelta({ upserted: [], removedIds: [], membership: [{ noteId: "a", groupId: "g2", at: 5000 }] });
    act(() => deliver({ membership: [{ noteId: "a", groupId: "g1", at: 4000 }] }));

    // The late peer op is stale; nothing moved into g1.
    expect(hook.result.current.snapshot.groups.find((g) => g.id === "g1")?.noteIds).toEqual([]);
  });

  it("keeps the receiver's per-machine collapsed state on rename and insert", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [
      group("g1", { collapsed: true }),
    ]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({
      upserted: [
        { id: "g1", name: "Renamed", createdAt: 1000, orderKey: "m", orderUpdatedAt: 1000, updatedAt: 4000 },
        { id: "g-new", name: "New", createdAt: 2000, orderKey: "z", orderUpdatedAt: 2000, updatedAt: 2000 },
      ],
    }));

    const groups = hook.result.current.snapshot.groups;
    expect(groups.find((g) => g.id === "g1")?.collapsed).toBe(true);
    expect(groups.find((g) => g.id === "g-new")?.collapsed).toBe(false);
  });

  it("inserts an unknown group at its orderKey position", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [
      group("g1", { orderKey: "a" }),
      group("g3", { orderKey: "z" }),
    ]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({ upserted: [{ id: "g2", name: "Mid", createdAt: 2000, orderKey: "m", orderUpdatedAt: 2000, updatedAt: 2000 }] }));

    expect(hook.result.current.snapshot.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
  });

  it("an op for a missing group removes the note everywhere; a same-delta upsert receives it", async () => {
    const hook = renderWindowSync(async () => true, [makeDoc("a")], [], [
      group("g1", { noteIds: ["a"] }),
    ]);
    await waitFor(() => expect(refs.handlers.has("groups-updated")).toBe(true));

    act(() => deliver({
      upserted: [{ id: "g-new", name: "New", createdAt: 2000, orderKey: "z", orderUpdatedAt: 2000, updatedAt: 2000 }],
      membership: [{ noteId: "a", groupId: "g-new", at: 3000 }],
    }));

    const groups = hook.result.current.snapshot.groups;
    expect(groups.find((g) => g.id === "g1")?.noteIds).toEqual([]);
    expect(groups.find((g) => g.id === "g-new")?.noteIds).toEqual(["a"]);
  });
});
