import { fileNameFromPath } from "./storagePaths";

export type ConflictKind = "note" | "manifest" | "groups" | "meta";

export interface DetectedConflictFile {
  kind: ConflictKind;
  canonicalName: string;
  marker: string;
}

const CONFLICT_MARKERS = [
  /\s*\(([^)]*conflicted copy[^)]*)\)/i,
  /\s*\(([^)]*conflict[^)]*)\)/i,
  /\s*\(([^)]*'s conflicted copy[^)]*)\)/i,
  /\s*\(([^)]*복사본[^)]*)\)/i,
  /\s*\((\d+)\)$/,
  /\s*-\s*Copy$/i,
];

function splitExt(name: string): { stem: string; ext: string } {
  const match = /^(.*?)(\.[^.]+)$/.exec(name);
  return match ? { stem: match[1], ext: match[2] } : { stem: name, ext: "" };
}

function stripConflictMarker(stem: string): { canonicalStem: string; marker: string } | null {
  for (const pattern of CONFLICT_MARKERS) {
    const match = pattern.exec(stem);
    if (!match) continue;
    return {
      canonicalStem: stem.slice(0, match.index).trimEnd(),
      marker: match[1] ?? match[0].trim(),
    };
  }
  return null;
}

export function detectConflictFile(pathOrName: string): DetectedConflictFile | null {
  const name = fileNameFromPath(pathOrName);
  const { stem, ext } = splitExt(name);
  const stripped = stripConflictMarker(stem);
  if (!stripped) return null;

  const canonicalName = `${stripped.canonicalStem}${ext}`;
  if (ext.toLowerCase() === ".md") {
    return { kind: "note", canonicalName, marker: stripped.marker };
  }
  if (/^manifest.*\.json$/i.test(canonicalName)) {
    return { kind: "manifest", canonicalName: "manifest.json", marker: stripped.marker };
  }
  if (/^\.groups\.json$/i.test(canonicalName)) {
    return { kind: "groups", canonicalName: ".groups.json", marker: stripped.marker };
  }
  if (ext.toLowerCase() === ".json") {
    return { kind: "meta", canonicalName, marker: stripped.marker };
  }
  return null;
}

export function hasConflictMarker(pathOrName: string): boolean {
  return detectConflictFile(pathOrName) !== null;
}
