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

// DOS device names are reserved by Win32 even with an extension (`NUL.txt`), so
// `.assets/NUL` would not be a real directory. Matched against the part before
// the first dot, case-insensitively.
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isValidNoteId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_NOTE_ID_LENGTH) return false;
  if (FORBIDDEN_CHARS.test(id)) return false;
  // Win32 silently trims leading/trailing spaces and trailing dots from each
  // path component, so an id like `...`, ` `, or `.. ` resolves to a *different*
  // directory than written: `.assets/...` -> `.assets` (wipes every note's
  // images) and `.assets/.. ` -> `.assets/..` = the notes root (total wipe).
  // Rejecting all trailing dots/spaces (and leading whitespace) also covers
  // `.`, `..`, and any id composed solely of dots and/or spaces.
  if (id !== id.trim()) return false;
  if (id.endsWith(".")) return false;
  if (WIN_RESERVED_NAME.test(id.split(".")[0])) return false;
  return true;
}
