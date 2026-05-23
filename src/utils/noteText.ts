/**
 * Pure text helpers for note titles and previews. Kept in a leaf module so
 * IO-layer files (reconcileFolder.ts, etc.) can use them without pulling in
 * the useNotesLoader hook's React surface.
 */

export function getFileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function stripInlineMarkdown(text: string): string {
  let s = text;
  s = s.replace(/\[\[([^\[\]\n]+)\]\]/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}(.*?)_{1,3}/g, "$1");
  s = s.replace(/~~(.*?)~~/g, "$1");
  s = s.replace(/&[a-zA-Z]+;|&#\d+;/g, " ");
  return s.trim();
}

function stripBlockMarkers(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^(?:>\s*)+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "");
}

export function deriveTitle(content: string): string {
  if (!content) return "";
  const lines = content.trimStart().split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("![") || line.startsWith("<img") || line.startsWith("```")) continue;
    const heading = stripInlineMarkdown(stripBlockMarkers(line));
    if (heading) return heading.slice(0, 20);
  }
  return "";
}

export function stripMarkdownContent(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const result: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("![") || line.startsWith("<img")) continue;
    if (/^[-*_]{3,}\s*$/.test(line)) continue;

    const plain = stripInlineMarkdown(stripBlockMarkers(line));
    if (plain) result.push(plain);
  }

  return result.join(" ").replace(/\s+/g, " ").trim();
}
