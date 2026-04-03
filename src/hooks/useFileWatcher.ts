import { useEffect, useRef, useCallback } from "react";
import { watch, readTextFile } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import { getNotesDir, deriveTitle, saveManifest, migrationInProgress, reconcileFolder } from "./useNotesLoader";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import { isOwnWrite, pruneOwnWrites } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import type { Locale, NotesSortOrder } from "./useSettings";

// Re-export markOwnWrite for existing consumers
export { markOwnWrite } from "./ownWriteTracker";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

interface ManifestFile {
  version: 1;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  activeNoteId: string | null;
  groups?: NoteGroup[];
}

async function readManifestFile(dir: string): Promise<ManifestFile | null> {
  try {
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const raw = await readTextFile(`${dir}${sep}manifest.json`);
    return JSON.parse(raw) as ManifestFile;
  } catch {
    return null;
  }
}

// ── File watcher hook ──

export function useFileWatcher(
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  groups: NoteGroup[],
  setGroups: React.Dispatch<React.SetStateAction<NoteGroup[]>>,
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  tiptapRef: React.RefObject<{ setContent: (md: string) => void } | null>,
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled: boolean,
  onActiveDocChanged?: (doc: { filePath: string; content: string }) => void,
) {
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const onActiveDocChangedRef = useRef(onActiveDocChanged);
  onActiveDocChangedRef.current = onActiveDocChanged;

  const handleWatchEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const dir = await getNotesDir();
    const dirNorm = normalizePath(dir);

    const affectedPaths = event.paths.map(normalizePath);
    const isManifestChange = affectedPaths.some(
      (p) => p.endsWith("/manifest.json") && p.startsWith(dirNorm) && !isOwnWrite(p),
    );
    const mdChanges = affectedPaths.filter(
      (p) => p.endsWith(".md") && p.startsWith(dirNorm) && !isOwnWrite(p),
    );

    if (!isManifestChange && mdChanges.length === 0) return;

    // ── Handle manifest.json changes (groups, note metadata from other device) ──
    if (isManifestChange) {
      const manifest = await readManifestFile(dir);
      if (!manifest) return;

      const currentDocs = docsRef.current;

      // Sync groups
      if (manifest.groups) {
        setGroups(manifest.groups);
      }

      // Discover new notes from manifest that we don't have
      const currentIds = new Set(currentDocs.map((d) => d.id));
      const newEntries = manifest.notes.filter((n) => !currentIds.has(n.id));

      if (newEntries.length > 0) {
        const newDocs = await Promise.all(
          newEntries.map(async (entry) => {
            let content = "";
            try { content = await readTextFile(entry.filePath); } catch { /* file may not be synced yet */ }
            return { ...entry, isDirty: false, content } as NoteDoc;
          }),
        );
        setDocs((prev) => {
          const ids = new Set(prev.map((d) => d.id));
          const toAdd = newDocs.filter((d) => !ids.has(d.id));
          return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
        });
      }

      // Update metadata (fileName, etc.) for existing notes from manifest
      const manifestMap = new Map(manifest.notes.map((n) => [n.id, n]));
      setDocs((prev) => {
        let changed = false;
        const next = prev.map((d) => {
          const remote = manifestMap.get(d.id);
          if (!remote) return d;
          // Only update if remote is newer and doc is not locally dirty
          if (!d.isDirty && remote.updatedAt > d.updatedAt) {
            changed = true;
            return { ...d, fileName: remote.fileName, updatedAt: remote.updatedAt };
          }
          return d;
        });
        return changed ? next : prev;
      });

    }

    // ── Handle .md file changes ──
    if (mdChanges.length === 0) return;

    const currentDocs = docsRef.current;

    for (const changedPath of mdChanges) {
      // Find matching doc by normalized path
      const docIndex = currentDocs.findIndex(
        (d) => normalizePath(d.filePath) === changedPath,
      );

      if (docIndex >= 0) {
        const doc = currentDocs[docIndex];

        // Skip if locally dirty (user is actively editing)
        if (doc.isDirty) continue;

        // Reload content
        let content: string;
        try {
          content = await readTextFile(doc.filePath);
        } catch {
          // File was deleted — will be handled by reconcile
          continue;
        }

        // Skip if content unchanged
        if (content === doc.content) continue;

        const { updatedAt: fileUpdatedAt } = await getFileTimestamps(doc.filePath);

        let needsSyncMarkdown = false;

        setDocs((prev) => {
          const idx = prev.findIndex((d) => d.id === doc.id);
          if (idx < 0) return prev;
          const updated = [...prev];
          const autoTitle = prev[idx].customName
            ? prev[idx].fileName
            : deriveTitle(content) || prev[idx].fileName;
          updated[idx] = {
            ...prev[idx],
            content,
            fileName: autoTitle,
            updatedAt: fileUpdatedAt,
            isDirty: false,
          };

          // If this is the active document, update editor
          if (idx === activeIndexRef.current && tiptapRef.current) {
            tiptapRef.current.setContent(content);
            needsSyncMarkdown = true;
          }

          return updated;
        });

        if (needsSyncMarkdown) {
          onActiveDocChangedRef.current?.({ filePath: doc.filePath, content });
        }
      }
    }

    // Reconcile: pick up new files or remove deleted ones
    const { docs: reconciledDocs, groups: reconciledGroups, changed } = await reconcileFolder(
      dir,
      docsRef.current,
      groupsRef.current,
      locale,
    );

    if (changed) {
      setDocs(reconciledDocs);
      setGroups(reconciledGroups);

      // Adjust activeIndex if it's now out of bounds
      if (activeIndexRef.current >= reconciledDocs.length) {
        setActiveIndex(Math.max(0, reconciledDocs.length - 1));
      }

      // Persist reconciled state
      const activeDoc = reconciledDocs[activeIndexRef.current];
      await saveManifest(reconciledDocs, activeDoc?.id ?? null, reconciledGroups).catch(() => {});
    }
  }, [locale, setDocs, setGroups, setActiveIndex, tiptapRef, notesSortOrder]);

  useEffect(() => {
    if (!enabled) return;

    let unwatchFn: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const dir = await getNotesDir();
      if (cancelled) return;

      try {
        const unwatch = await watch(
          dir,
          handleWatchEvent,
          { recursive: false, delayMs: 1500 },
        );
        if (cancelled) {
          unwatch();
        } else {
          unwatchFn = unwatch;
        }
      } catch (err) {
        console.warn("File watcher setup failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      unwatchFn?.();
    };
  }, [enabled, handleWatchEvent]);
}
