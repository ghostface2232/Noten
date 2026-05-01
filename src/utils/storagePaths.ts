export function joinPath(dir: string, child: string): string {
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}${child}`;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizePathKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

export function fileNameFromPath(path: string): string {
  return normalizePath(path).split("/").pop() ?? "";
}

export function noteFilePath(notesDir: string, noteId: string): string {
  return joinPath(notesDir, `${noteId}.md`);
}

export function metaDirPath(notesDir: string): string {
  return joinPath(notesDir, ".meta");
}

export function metaFilePath(notesDir: string, noteId: string): string {
  return joinPath(metaDirPath(notesDir), `${noteId}.json`);
}

export function groupsFilePath(notesDir: string): string {
  return joinPath(notesDir, ".groups.json");
}

export function manifestCachePath(notesDir: string): string {
  return joinPath(notesDir, "manifest-cache.json");
}

export function conflictDirPath(notesDir: string): string {
  return joinPath(notesDir, ".conflicts");
}

export function trashDirPath(notesDir: string): string {
  return joinPath(notesDir, ".trash");
}
