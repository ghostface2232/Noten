import type { Locale } from "../hooks/useSettings";

export function getDefaultDocumentTitle(locale: Locale): string {
  return locale === "ko" ? "제목 없음" : "Untitled";
}
