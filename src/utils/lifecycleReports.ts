import { logNotenError } from "./crashLog";
import { libraryStore } from "./libraryStore";
import { NotenError } from "./notenError";

// Delete, restore and purge keep a failed note where it was and return quietly,
// which reads as success unless the note is still there when they finish.

export function reportNotesNotDeleted(requestedIds: string[], deletedIds: string[]): void {
  const deleted = new Set(deletedIds);
  const live = new Set(libraryStore.getSnapshot().docs.map((doc) => doc.id));
  const failed = requestedIds.filter((id) => !deleted.has(id) && live.has(id));
  if (failed.length === 0) return;
  void logNotenError(new NotenError("DELETE_FAILED", "fatal", `${failed.length} note(s) are still live after a delete`, {
    context: { noteIds: failed },
  }));
}

export function reportNotesNotPurged(noteIds: string[]): void {
  const requested = new Set(noteIds);
  const failed = libraryStore.getSnapshot().trashedNotes.filter((note) => requested.has(note.id));
  if (failed.length === 0) return;
  void logNotenError(new NotenError("TRASH_PURGE_FAILED", "fatal", `${failed.length} note(s) are still in the trash after a purge`, {
    context: { noteIds: failed.map((note) => note.id) },
  }));
}

export function reportNoteNotRestored(noteId: string): void {
  if (!libraryStore.getSnapshot().trashedNotes.some((note) => note.id === noteId)) return;
  void logNotenError(new NotenError("RESTORE_FAILED", "fatal", "The note is still in the trash after a restore", {
    context: { noteId },
  }));
}
