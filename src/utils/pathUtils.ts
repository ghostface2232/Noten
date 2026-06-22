/**
 * Ensure a directory string ends with a separator so it can be safely joined
 * with a relative segment via plain template string concatenation. Accepts
 * either separator since paths from Tauri/appDataDir may use backslashes on
 * Windows and forward slashes on Linux/macOS.
 */
export function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

/**
 * Lexically test whether `candidate` resolves strictly inside `base` — used as
 * a defense-in-depth guard before recursive deletes, so a traversal segment
 * (`..`) that slipped past id validation cannot escape the intended directory.
 * Both separators are unified and `.`/`..`/empty segments are resolved without
 * touching the filesystem (Tauri offers no sync canonicalize). Returns false
 * when `candidate` equals `base` or climbs above it.
 */
export function isStrictSubpath(base: string, candidate: string): boolean {
  const resolve = (p: string): string[] => {
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return ["\0escaped"]; // climbed above root
        out.pop();
      } else {
        out.push(seg);
      }
    }
    return out;
  };
  const baseParts = resolve(base);
  const candParts = resolve(candidate);
  if (candParts[0] === "\0escaped" || baseParts[0] === "\0escaped") return false;
  if (candParts.length <= baseParts.length) return false;
  return baseParts.every((seg, i) => candParts[i] === seg);
}
