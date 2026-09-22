import type { Locale } from "../hooks/useSettings";

const BASE_TITLES: Record<Locale, string> = {
  ko: "제목 없음",
  en: "Untitled",
};

export function getDefaultDocumentTitle(locale: Locale, existingNames?: string[]): string {
  const base = BASE_TITLES[locale];
  if (!existingNames || existingNames.length === 0) return base;

  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: (\\d+))?$`);
  let maxNum = 0;
  let baseExists = false;

  for (const name of existingNames) {
    const m = name.match(pattern);
    if (!m) continue;
    if (m[1]) {
      maxNum = Math.max(maxNum, parseInt(m[1], 10));
    } else {
      baseExists = true;
    }
  }

  if (!baseExists && maxNum === 0) return base;
  return `${base} ${Math.max(maxNum, baseExists ? 1 : 0) + 1}`;
}

/**
 * Rebase a disk or sidecar read of a note's title onto the live doc.
 *
 * `customName` only ever turns on for a live note: a rename sets it together
 * with the manual title, and no user action clears it. A read that has it off
 * while the live doc has it on therefore predates that rename, and adopting it
 * would roll the title back and re-arm the empty-note prunes, which read
 * `customName` and delete permanently. Every other combination defers to the
 * read, so a later rename landing from disk still wins.
 */
export function keepManualTitle<T extends { fileName: string; customName?: boolean }>(
  live: { fileName: string; customName?: boolean },
  incoming: T,
): T {
  if (!live.customName || incoming.customName) return incoming;
  return { ...incoming, fileName: live.fileName, customName: true };
}
