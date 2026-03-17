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
