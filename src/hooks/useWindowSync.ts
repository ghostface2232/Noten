import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type { NoteDoc } from "./useNotesLoader";

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

/* ── Listener hook ── */

export function useWindowSync(
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  tiptapRef: React.RefObject<{ setContent: (md: string) => void } | null>,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  // Refs to avoid stale closures in event listeners
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<DocUpdatedPayload>("doc-updated", (event) => {
      const { sourceWindow, docId, content, fileName, updatedAt } = event.payload;
      if (sourceWindow === WINDOW_LABEL) return;

      setDocs((prev) => {
        const idx = prev.findIndex((d) => d.id === docId);
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], content, fileName, updatedAt, isDirty: false };

        if (idx === activeIndexRef.current && tiptapRef.current) {
          tiptapRef.current.setContent(content);
        }
        return updated;
      });
    }).then((fn) => unlisteners.push(fn));

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
    }).then((fn) => unlisteners.push(fn));

    listen<DocDeletedPayload>("doc-deleted", (event) => {
      const { sourceWindow, docId } = event.payload;
      if (sourceWindow === WINDOW_LABEL) return;

      setDocs((prev) => {
        const idx = prev.findIndex((d) => d.id === docId);
        if (idx < 0) return prev;
        const filtered = prev.filter((d) => d.id !== docId);
        // Adjust activeIndex if needed
        if (activeIndexRef.current >= filtered.length) {
          setActiveIndex(Math.max(0, filtered.length - 1));
        }
        return filtered;
      });
    }).then((fn) => unlisteners.push(fn));

    listen<DocCreatedPayload>("doc-created", (event) => {
      const { sourceWindow, doc } = event.payload;
      if (sourceWindow === WINDOW_LABEL) return;

      setDocs((prev) => {
        if (prev.some((d) => d.id === doc.id || d.filePath === doc.filePath)) return prev;
        return [...prev, { ...doc, isDirty: false }];
      });
    }).then((fn) => unlisteners.push(fn));

    return () => { unlisteners.forEach((fn) => fn()); };
  }, [setDocs, setActiveIndex, tiptapRef]);
}
