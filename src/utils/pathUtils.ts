/**
 * Ensure a directory string ends with a separator so it can be safely joined
 * with a relative segment via plain template string concatenation. Accepts
 * either separator since paths from Tauri/appDataDir may use backslashes on
 * Windows and forward slashes on Linux/macOS.
 */
export function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}
