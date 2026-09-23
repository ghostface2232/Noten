import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NoteGroup } from "../utils/noteTypes";

vi.mock("./useNotesLoader", () => ({
  saveManifest: vi.fn(async () => {}),
  markGroupAsDeleted: vi.fn(),
  markGroupMembershipChanged: vi.fn(),
  markGroupMembershipChanges: vi.fn(),
}));
vi.mock("./useUiState", () => ({ setGroupCollapsedPersisted: vi.fn(async () => {}) }));
vi.mock("./useWindowSync", () => ({ emitGroupsDelta: vi.fn() }));

import { useNoteGroups } from "./useNoteGroups";

function group(id: string, orderKey: string): NoteGroup {
  return { id, name: id, noteIds: [], collapsed: false, createdAt: 1, orderKey, orderUpdatedAt: 1 };
}

/** The comparator the loader and the window-sync receiver sort groups with. */
function sortedIds(groups: NoteGroup[]): string[] {
  return [...groups].sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak === bk) return a.createdAt - b.createdAt;
    return ak < bk ? -1 : 1;
  }).map((g) => g.id);
}

function renderGroups(initial: NoteGroup[]) {
  return renderHook(() => {
    const [groups, setGroups] = useState(initial);
    return { groups, ...useNoteGroups(groups, setGroups, [], 0) };
  });
}

describe("useNoteGroups — reorder", () => {
  it("moves only the dragged group's key when the position is representable", () => {
    const { result } = renderGroups([group("a", "a"), group("b", "b"), group("c", "c")]);
    act(() => result.current.reorderGroups(2, 0));

    expect(result.current.groups.map((g) => g.id)).toEqual(["c", "a", "b"]);
    expect(sortedIds(result.current.groups)).toEqual(["c", "a", "b"]);
    expect(result.current.groups.filter((g) => g.orderUpdatedAt !== 1).map((g) => g.id)).toEqual(["c"]);
  });

  // Dragging a group to the top again and again walks the first key down to
  // "0", and nothing sorts before "0". The generated key landed after it, so
  // the group rendered second everywhere else and repeating the drag could
  // not fix it.
  it("rekeys the whole list when nothing fits before the first key", () => {
    const { result } = renderGroups([group("a", "0"), group("b", "5"), group("c", "a")]);
    act(() => result.current.reorderGroups(2, 0));

    expect(result.current.groups.map((g) => g.id)).toEqual(["c", "a", "b"]);
    expect(sortedIds(result.current.groups)).toEqual(["c", "a", "b"]);
    // Every group has room on both sides again.
    for (const g of result.current.groups) expect(g.orderKey).not.toBe("0");
  });

  it("rekeys when no key fits between a key and that key plus a zero", () => {
    const { result } = renderGroups([group("a", "k"), group("b", "k0"), group("c", "z")]);
    act(() => result.current.reorderGroups(2, 1));

    expect(result.current.groups.map((g) => g.id)).toEqual(["a", "c", "b"]);
    expect(sortedIds(result.current.groups)).toEqual(["a", "c", "b"]);
  });

  it("rekeys when a neighbour carries no key at all", () => {
    const { result } = renderGroups([
      { ...group("a", ""), orderKey: undefined },
      group("b", "m"),
    ]);
    act(() => result.current.reorderGroups(1, 0));
    expect(sortedIds(result.current.groups)).toEqual(["b", "a"]);
  });
});

describe("useNoteGroups — create", () => {
  it("rekeys when the appended key would fall back to a time key", () => {
    const long = "z".repeat(32);
    const { result } = renderGroups([group("a", "m"), group("b", long)]);
    act(() => { result.current.createGroup("new"); });

    expect(result.current.groups.map((g) => g.name)).toEqual(["a", "b", "new"]);
    expect(sortedIds(result.current.groups).map((id) => result.current.groups.find((g) => g.id === id)!.name))
      .toEqual(["a", "b", "new"]);
  });
});
