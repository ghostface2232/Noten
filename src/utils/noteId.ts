// Note ids become path segments on disk (`<id>.md`, `.meta/<id>.json`,
// `.assets/<id>/`). They originate as `crypto.randomUUID()`, but legacy and
// imported notes intentionally keep non-UUID stems (see reconcileFolder's
// fileNameToId), so validation must stay filename-safe rather than UUID-only.
//
// The security property: an id read back from a shared/cloud folder is
// untrusted input. A crafted id of `..` (or anything containing a path
// separator) escapes its parent directory — `${notesDir}/.assets/..` resolves
// to `notesDir` itself, so a recursive delete would wipe every note. Reject
// any id that is not a single, separator-free, non-dot path segment.

// Filenames are capped at 255 on every target filesystem; anything longer is
// not a real note id we wrote.
const MAX_NOTE_ID_LENGTH = 255;

// Reject anything that would change the meaning of `<id>` as a single path
// segment: ASCII control chars, the two path separators, and the Windows
// reserved set (`:` also guards against NTFS alternate-data-stream syntax).
// UUIDs and ordinary imported filenames (which keep `-`, `.`, `_`, unicode)
// pass; `..`, `a/b`, `a\b`, `C:` do not.
const FORBIDDEN_CHARS = /[\x00-\x1f<>:"/\\|?*]/;

export function isValidNoteId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_NOTE_ID_LENGTH) return false;
  if (id === "." || id === "..") return false;
  if (FORBIDDEN_CHARS.test(id)) return false;
  return true;
}
