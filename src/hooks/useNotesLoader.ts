import { useState, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile, readDir } from "@tauri-apps/plugin-fs";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";

export interface NoteDoc {
  id: string;
  filePath: string;
  fileName: string;
  isExternal: boolean;
  isDirty: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface Manifest {
  version: 1;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  activeNoteId: string | null;
}

const UI_STATE_STORAGE_KEY = "markdown-studio-ui-state";

let notesDirCache: string | null = null;

export function sortNotes(docs: NoteDoc[], order: NotesSortOrder): NoteDoc[] {
  const sorted = [...docs];
  const direction = order === "recent-first" ? -1 : 1;

  sorted.sort((a, b) => {
    const updatedDiff = a.updatedAt - b.updatedAt;
    if (updatedDiff !== 0) return updatedDiff * direction;

    const createdDiff = a.createdAt - b.createdAt;
    if (createdDiff !== 0) return createdDiff * direction;

    return a.fileName.localeCompare(b.fileName);
  });

  return sorted;
}

export async function getNotesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  const base = await appDataDir();
  notesDirCache = `${base}notes`;
  return notesDirCache;
}

async function ensureNotesDir(): Promise<string> {
  const dir = await getNotesDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

function readStoredManifest(): Manifest | null {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

function writeStoredManifest(manifest: Manifest) {
  localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(manifest));
}

async function readFileContent(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return "";
  }
}

export async function saveManifest(
  docs: NoteDoc[],
  activeId: string | null,
): Promise<void> {
  const manifest: Manifest = {
    version: 1,
    notes: docs.map(({ id, filePath, fileName, isExternal, createdAt, updatedAt }) => ({
      id,
      filePath,
      fileName,
      isExternal,
      createdAt,
      updatedAt,
    })),
    activeNoteId: activeId,
  };

  try {
    writeStoredManifest(manifest);
  } catch {
    console.warn("Failed to persist UI state manifest.");
  }
}

export function useNotesLoader(
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled = true,
) {
  const [docs, setDocs] = useState<NoteDoc[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;

    (async () => {
      try {
        const dir = await ensureNotesDir();
        const manifest = readStoredManifest();

        if (manifest && manifest.notes.length > 0) {
          const loaded = await Promise.all(
            manifest.notes.map(async (entry) => {
              const content = await readFileContent(entry.filePath);
              return { ...entry, isDirty: false, content } as NoteDoc;
            }),
          );

          const sorted = sortNotes(loaded, notesSortOrder);
          setDocs(sorted);

          const activeId = manifest.activeNoteId ?? sorted[0]?.id ?? null;
          const nextActiveIndex = activeId
            ? sorted.findIndex((doc) => doc.id === activeId)
            : 0;
          setActiveIndex(nextActiveIndex >= 0 ? nextActiveIndex : 0);
        } else {
          let foundNotes: NoteDoc[] = [];

          try {
            const entries = await readDir(dir);
            const markdownEntries = entries.filter((entry) => entry.name?.endsWith(".md"));
            foundNotes = await Promise.all(
              markdownEntries.map(async (entry) => {
                const id = entry.name!.replace(/\.md$/, "");
                const filePath = `${dir}/${entry.name}`;
                const content = await readFileContent(filePath);
                const timestamp = Date.now();
                return {
                  id,
                  filePath,
                  fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
                  isExternal: false,
                  isDirty: false,
                  content,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                } as NoteDoc;
              }),
            );
          } catch {
            console.warn("Failed to scan notes directory.");
          }

          if (foundNotes.length === 0) {
            const id = crypto.randomUUID();
            const filePath = `${dir}/${id}.md`;
            const timestamp = Date.now();
            await writeTextFile(filePath, "");
            foundNotes = [{
              id,
              filePath,
              fileName: getDefaultDocumentTitle(locale),
              isExternal: false,
              isDirty: false,
              content: "",
              createdAt: timestamp,
              updatedAt: timestamp,
            }];
          }

          const sorted = sortNotes(foundNotes, notesSortOrder);
          setDocs(sorted);
          setActiveIndex(0);
          await saveManifest(sorted, sorted[0]?.id ?? null);
        }
      } catch (err) {
        console.warn("Notes loader failed:", err);
        const timestamp = Date.now();
        setDocs([{
          id: "local",
          filePath: "",
          fileName: getDefaultDocumentTitle(locale),
          isExternal: false,
          isDirty: false,
          content: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        }]);
        setActiveIndex(0);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [enabled, locale, notesSortOrder]);

  return { docs, setDocs, activeIndex, setActiveIndex, isLoading };
}

export function deriveTitle(content: string): string {
  if (!content) return "";
  const firstLine = content.trimStart().split("\n")[0];
  const heading = firstLine.replace(/^#+\s*/, "").trim();
  return heading.slice(0, 60) || "";
}
