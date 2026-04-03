import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type { NoteDoc, NoteGroup, TrashedNote } from "./useNotesLoader";
import { setTrashedNotesCache } from "./useNotesLoader";

interface DocUpdatedPayload {
  sourceWindow: string;
  docId: string;
  content: string;
  fileName: string;
  updatedAt: number;
}

interface DocRenamedPayload {
  sourceWindow: string;
  docId: string;
  oldFilePath: string;
  newFilePath: string;
  newFileName: string;
}

interface DocDeletedPayload {
  sourceWindow: string;
  docId: string;
}

interface DocCreatedPayload {
  sourceWindow: string;
  doc: Omit<NoteDoc, "isDirty">;
}

interface GroupsUpdatedPayload {
  sourceWindow: string;
  groups: NoteGroup[];
}

interface TrashUpdatedPayload {
  sourceWindow: string;
  trashedNotes: TrashedNote[];
}

const WINDOW_LABEL = getCurrentWindow().label;

/* ── Emit helpers ── */

export function emitDocUpdated(docId: string, content: string, fileName: string) {
  emit("doc-updated", {
    sourceWindow: WINDOW_LABEL, docId, content, fileName, updatedAt: Date.now(),
  } satisfies DocUpdatedPayload).catch(() => {});
}

export function emitDocRenamed(docId: string, oldFilePath: string, newFilePath: string, newFileName: string) {
  emit("doc-renamed", {
    sourceWindow: WINDOW_LABEL, docId, oldFilePath, newFilePath, newFileName,
  } satisfies DocRenamedPayload).catch(() => {});
}

export function emitDocDeleted(docId: string) {
  emit("doc-deleted", {
    sourceWindow: WINDOW_LABEL, docId,
  } satisfies DocDeletedPayload).catch(() => {});
}

export function emitDocCreated(doc: NoteDoc) {
  const { isDirty: _, ...rest } = doc;
  emit("doc-created", {
    sourceWindow: WINDOW_LABEL, doc: rest,
  } satisfies DocCreatedPayload).catch(() => {});
}

export function emitGroupsUpdated(groups: NoteGroup[]) {
  emit("groups-updated", {
    sourceWindow: WINDOW_LABEL, groups,
  } satisfies GroupsUpdatedPayload).catch(() => {});
}

export function emitTrashUpdated(trashedNotes: TrashedNote[]) {
  emit("trash-updated", {
    sourceWindow: WINDOW_LABEL, trashedNotes,
  } satisfies TrashUpdatedPayload).catch(() => {});
}

/* ── Listener hook ── */

export function useWindowSync(
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  tiptapRef: React.RefObject<{ setContent: (md: string) => void } | null>,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  setGroups?: React.Dispatch<React.SetStateAction<NoteGroup[]>>,
  setTrashedNotes?: (updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[])) => void,
  onActiveDocChanged?: (doc: { filePath: string; content: string }) => void,
) {
  // Refs to avoid stale closures in event listeners
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const onActiveDocChangedRef = useRef(onActiveDocChanged);
  onActiveDocChangedRef.current = onActiveDocChanged;

  useEffect(() => {
    let mounted = true;
    let unlisteners: (() => void)[] = [];

    Promise.all([
      listen<DocUpdatedPayload>("doc-updated", (event) => {
        const { sourceWindow, docId, content, fileName, updatedAt } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        let needsSyncMarkdown = false;
        let syncFilePath = "";

        // flushSync forces the updater to run synchronously so the
        // flags it sets are reliable when checked afterwards.
        flushSync(() => {
          setDocs((prev) => {
            const idx = prev.findIndex((d) => d.id === docId);
            if (idx < 0) return prev;
            const updated = [...prev];
            updated[idx] = { ...updated[idx], content, fileName, updatedAt, isDirty: false };

            if (idx === activeIndexRef.current) {
              needsSyncMarkdown = true;
              syncFilePath = updated[idx].filePath;
            }
            return updated;
          });
        });

        if (needsSyncMarkdown && tiptapRef.current) {
          tiptapRef.current.setContent(content);
          onActiveDocChangedRef.current?.({ filePath: syncFilePath, content });
        }
      }),

      listen<DocRenamedPayload>("doc-renamed", (event) => {
        const { sourceWindow, docId, newFilePath, newFileName } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        setDocs((prev) => {
          const idx = prev.findIndex((d) => d.id === docId);
          if (idx < 0) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], filePath: newFilePath, fileName: newFileName };
          return updated;
        });
      }),

      listen<DocDeletedPayload>("doc-deleted", (event) => {
        const { sourceWindow, docId } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        setDocs((prev) => {
          const idx = prev.findIndex((d) => d.id === docId);
          if (idx < 0) return prev;

          const filtered = prev.filter((d) => d.id !== docId);
          if (filtered.length === 0) {
            setActiveIndex(0);
            return filtered;
          }

          const currentActive = activeIndexRef.current;

          if (idx === currentActive) {
            // Deleted doc is the active doc — load new active doc's content
            const newIdx = Math.min(idx, filtered.length - 1);
            setActiveIndex(newIdx);
            const newDoc = filtered[newIdx];
            if (tiptapRef.current && newDoc) {
              tiptapRef.current.setContent(newDoc.content);
            }
            if (newDoc) {
              onActiveDocChanged?.({ filePath: newDoc.filePath, content: newDoc.content });
            }
          } else if (idx < currentActive) {
            // Deleted doc is before active doc — shift index down
            setActiveIndex(currentActive - 1);
          }
          // idx > currentActive — no change needed

          return filtered;
        });
      }),

      listen<DocCreatedPayload>("doc-created", (event) => {
        const { sourceWindow, doc } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        setDocs((prev) => {
          if (prev.some((d) => d.id === doc.id || d.filePath === doc.filePath)) return prev;
          return [...prev, { ...doc, isDirty: false }];
        });
      }),

      listen<GroupsUpdatedPayload>("groups-updated", (event) => {
        const { sourceWindow, groups } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        setGroups?.(groups);
      }),

      listen<TrashUpdatedPayload>("trash-updated", (event) => {
        const { sourceWindow, trashedNotes } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        setTrashedNotesCache(trashedNotes);
        setTrashedNotes?.(trashedNotes);
      }),
    ]).then((fns) => {
      if (!mounted) { fns.forEach((fn) => fn()); return; }
      unlisteners = fns;
    });

    return () => { mounted = false; unlisteners.forEach((fn) => fn()); };
  }, [setDocs, setActiveIndex, tiptapRef, setGroups, setTrashedNotes, onActiveDocChanged]);
}
