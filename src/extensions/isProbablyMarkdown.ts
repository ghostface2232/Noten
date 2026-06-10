// Heuristic for the paste pipeline: does a plain-text clipboard payload look
// like Markdown the user wants parsed, rather than prose, code, or an email
// that merely contains a stray markdown-ish character?
//
// The old gate was a single regex (MD_PATTERN) that fired on any one of a few
// block markers, so a sentence containing "[text](url)" or a "a | b | c" line
// was wrongly parsed, while bold/italic/inline-code-only text was missed.
// This replaces it with a scored vote: decisive block syntax short-circuits to
// true, weaker inline signals accumulate, and non-Markdown shapes (HTML, email
// headers, bare URLs/addresses) subtract — compared against a length-aware
// threshold. Technique adapted from Notesnook's clipboard detector;
// reimplemented here rather than copied (Notesnook is GPL-3.0, Noten is MIT).

interface ScoredPattern {
  pattern: RegExp;
  score: number;
}

// Unambiguous block-level Markdown — any single match is decisive.
const DEFINITE: RegExp[] = [
  /^[ \t]*#{1,6}\s+\S/m, // ATX heading
  /^[ \t]*[-*+]\s+\[[ xX]\]\s/m, // task list item
  /^\|.+\|.+\|[ \t]*$/m, // table row with at least two columns
  /^[ \t]*>\s+\S/m, // blockquote
  /^[ \t]*```/m, // fenced code block
  /!\[[^\]]*\]\([^)\s]+\)/, // image
  /^\s*\[[^\]]+\]\([^)\s]+\)\s*$/, // the whole payload is a single inline link
];

const POSITIVE: ScoredPattern[] = [
  { pattern: /\[[^\]]+\]\([^)\s]+\)/, score: 2 }, // inline link
  { pattern: /^[ \t]*[-*+]\s+\S/m, score: 2 }, // unordered list
  { pattern: /^[ \t]*\d+\.\s+\S/m, score: 2 }, // ordered list
  { pattern: /^[-*_]{3,}[ \t]*$/m, score: 2 }, // thematic break
  { pattern: /(^|[^*])\*\*[^*\n]+\*\*/m, score: 1 }, // bold
  { pattern: /(^|[^*])\*[^*\n]+\*/m, score: 1 }, // italic
  { pattern: /`[^`\n]+`/, score: 1 }, // inline code
  { pattern: /~~[^~\n]+~~/, score: 1 }, // strikethrough
];

const NEGATIVE: ScoredPattern[] = [
  { pattern: /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i, score: -3 }, // HTML tag
  { pattern: /<\?xml/i, score: -4 }, // XML declaration
  { pattern: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}[ \t]*$/m, score: -3 }, // bare email line
  { pattern: /^https?:\/\/\S+[ \t]*$/m, score: -2 }, // bare URL line
  { pattern: /^(From|To|Subject|Date|Cc|Bcc|Sent):/m, score: -3 }, // email header
];

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const matches = text.match(new RegExp(pattern.source, flags));
  return matches ? matches.length : 0;
}

export function isProbablyMarkdown(text: string): boolean {
  if (!text.trim()) return false;

  if (DEFINITE.some((re) => re.test(text))) return true;

  let score = 0;
  for (const { pattern, score: weight } of POSITIVE) {
    score += weight * countMatches(text, pattern);
  }
  for (const { pattern, score: weight } of NEGATIVE) {
    score += weight * countMatches(text, pattern);
  }

  if (/\n/.test(text)) score += 1; // multi-line structure
  if (/\n[ \t]*\n/.test(text)) score += 1; // paragraph breaks

  const threshold = text.length > 100 ? 4 : 3;
  return score > threshold;
}
