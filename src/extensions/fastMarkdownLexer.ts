import { marked, Lexer, Marked } from "marked";
import type { Token, Tokens } from "marked";
import Underline from "@tiptap/extension-underline";
import { boundBlockExtension, MAYBE_ORDERED_ITEM } from "./boundedBlockTokenizers";

// Why this file exists
// --------------------
// `@tiptap/markdown` parses markdown with `marked`. marked's inline lexer
// (`Lexer.inlineTokens`) begins by masking out spans that must be skipped when
// scanning for emphasis/strikethrough delimiters: escaped punctuation, code
// spans, links, raw HTML, and reference links. Stock marked applies each mask
// with a loop of the shape:
//
//     for (; (m = rule.exec(n)) != null; )
//       n = n.slice(0, m.index) + replacement + n.slice(rule.lastIndex);
//
// Every iteration rebuilds the *entire* inline source string `n`. Because each
// rebuilt string must be re-flattened for the next `.exec()`, a single text
// block with K such matches costs O(K · n). When K grows with the block size
// (e.g. a 4,000,000-char note kept on one line / one paragraph that is dense
// with links, code spans, HTML tags, or backslash escapes) this is O(n²) and
// freezes the app for minutes. Measured: a 1,000,000-char single block of
// backslash escapes takes ~31s to lex; of code spans ~10s; of links ~6s. The
// SAME content split into normal blank-line-separated paragraphs lexes in
// ~0.1s, because each block's inline source stays small.
//
// The three masking replacements are all *equal length* by construction (each
// matched span is replaced by a same-length run of placeholder characters), so
// the masked string is identical whether we rebuild it once per match or in a
// single pass. `FastLexer` overrides `inlineTokens` to build the mask in one
// linear pass and otherwise reproduces marked's inline tokenization verbatim.
// `fastMarkdownLexer.test.ts` fuzzes this against stock marked to guard the
// equivalence (and would fail loudly if a marked upgrade changed the loop).

// Build the masked inline source in one pass per rule instead of rebuilding the
// whole string on every match. `build` returns the replacement for a match, or
// null to leave the matched span untouched (mirrors marked's conditional
// reference-link masking). marked relies on each replacement having the same
// length as the span it covers; we make no different assumption.
function maskInPlace(
  input: string,
  regex: RegExp,
  build: (match: RegExpExecArray) => string | null,
): string {
  regex.lastIndex = 0;
  let parts: string[] | null = null;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    // Guard against a zero-length match spinning forever. marked's rules never
    // match empty here, so this never fires for real input — it only keeps a
    // hypothetical pathological rule from hanging.
    if (regex.lastIndex === match.index) regex.lastIndex++;
    const replacement = build(match);
    if (replacement === null) continue;
    if (parts === null) parts = [];
    parts.push(input.slice(cursor, match.index));
    parts.push(replacement);
    cursor = regex.lastIndex;
  }
  if (parts === null) return input;
  parts.push(input.slice(cursor));
  return parts.join("");
}

// Reproduces the masking that stock marked's `inlineTokens` performs before its
// main tokenization loop, but in linear time. Order matches marked exactly:
// reference-link search, then escaped punctuation, then the block-skip rule
// (code / links / HTML).
function buildInlineMask(
  // The lexer's internals aren't in marked's public types; the shapes we touch
  // (`tokens.links`, `tokenizer.rules.inline`) are stable across the loop we
  // mirror and are guarded by the equivalence fuzz test.
  lexer: {
    tokens: { links?: Record<string, unknown> };
    tokenizer: { rules: { inline: Record<string, RegExp> } };
  },
  src: string,
): string {
  const rules = lexer.tokenizer.rules.inline;
  let masked = src;

  const links = lexer.tokens.links;
  if (links) {
    const refKeys = Object.keys(links);
    if (refKeys.length > 0) {
      masked = maskInPlace(masked, rules.reflinkSearch, (m) => {
        const label = m[0].slice(m[0].lastIndexOf("[") + 1, -1);
        if (!refKeys.includes(label)) return null;
        return "[" + "a".repeat(m[0].length - 2) + "]";
      });
    }
  }

  masked = maskInPlace(masked, rules.anyPunctuation, () => "++");

  masked = maskInPlace(masked, rules.blockSkip, (m) => {
    const prefixLen = m[2] ? m[2].length : 0;
    return m[0].slice(0, prefixLen) + "[" + "a".repeat(m[0].length - prefixLen - 2) + "]";
  });

  return masked;
}

// Inline `start` callbacks known to return the first index of a fixed string
// (see firstIndexOf).
const FIRST_INDEX_STARTS = new WeakSet<(src: string) => number>();

/**
 * An inline tokenizer `start` that returns the first index of `needle` in the
 * source. marked calls `start` for every text token with the whole rest of
 * the paragraph, so a plain `src.indexOf(needle)` rescans the paragraph each
 * time — O(tokens × length) when the needle is absent (a 800 KB paragraph
 * without "++" spent 450 ms on Underline's start alone). FastLexer remembers
 * where a start made this way found its needle and asks again only once
 * lexing has passed that point; that is exact because the first occurrence
 * in a suffix is the first occurrence in the whole string at or after the
 * suffix's offset.
 */
export function firstIndexOf(needle: string): (src: string) => number {
  const start = (src: string) => src.indexOf(needle);
  FIRST_INDEX_STARTS.add(start);
  return start;
}

class FastLexer extends Lexer {
  /** Remember firstIndexOf starts' results within a block (see firstIndexOf). */
  protected rememberInlineStarts = true;

  // Transcribed verbatim from marked 17's `Lexer.inlineTokens` main loop, with
  // ONLY the leading mask-building replaced by the linear `buildInlineMask`.
  // Keep this in lockstep with the installed marked version; the fuzz test in
  // fastMarkdownLexer.test.ts compares output against stock marked and fails if
  // they ever diverge.
  override inlineTokens(src: string, tokens: Token[] = []): Token[] {
    // marked internals are intentionally untyped on the public Lexer surface.
    const lexer = this as any;

    let maskedSrc = buildInlineMask(lexer, src);
    maskedSrc = lexer.options.hooks?.emStrongMask?.call({ lexer }, maskedSrc) ?? maskedSrc;

    // `keepPrevChar`/`prevChar` carry the character preceding the current span
    // so emphasis can tell intra-word `_` from delimiters.
    let keepPrevChar = false;
    let prevChar = "";
    let cutSrc = src;
    let token: any;
    // firstIndexOf start → absolute index of its next match in `src`, or -1
    // for none. Valid because `cutSrc` is always a suffix of `src`.
    const nextStart = new Map<unknown, number>();

    while (cutSrc) {
      if (!keepPrevChar) prevChar = "";
      keepPrevChar = false;

      if (
        lexer.options.extensions?.inline?.some((ext: any) => {
          token = ext.call({ lexer }, cutSrc, tokens);
          if (token) {
            cutSrc = cutSrc.substring(token.raw.length);
            tokens.push(token);
            return true;
          }
          return false;
        })
      ) {
        continue;
      }

      if ((token = lexer.tokenizer.escape(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.tag(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.link(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.reflink(cutSrc, lexer.tokens.links))) {
        cutSrc = cutSrc.substring(token.raw.length);
        const last = tokens[tokens.length - 1];
        if (token.type === "text" && last?.type === "text") {
          last.raw += token.raw;
          last.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if ((token = lexer.tokenizer.emStrong(cutSrc, maskedSrc, prevChar))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.codespan(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.br(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.del(cutSrc, maskedSrc, prevChar))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = lexer.tokenizer.autolink(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (!lexer.state.inLink && (token = lexer.tokenizer.url(cutSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      let textSrc = cutSrc;
      if (lexer.options.extensions?.startInline) {
        let startMin = Infinity;
        const tempSrc = cutSrc.slice(1);
        const tempOffset = src.length - tempSrc.length;
        let startPos: number | undefined;
        lexer.options.extensions.startInline.forEach((getStart: any) => {
          if (this.rememberInlineStarts && FIRST_INDEX_STARTS.has(getStart)) {
            const known = nextStart.get(getStart);
            let next: number;
            if (known === undefined || (known >= 0 && known < tempOffset)) {
              const found: number = getStart(tempSrc);
              next = found >= 0 ? tempOffset + found : -1;
              nextStart.set(getStart, next);
            } else {
              next = known;
            }
            startPos = next < 0 ? -1 : next - tempOffset;
          } else {
            startPos = getStart.call({ lexer }, tempSrc);
          }
          if (typeof startPos === "number" && startPos >= 0) {
            startMin = Math.min(startMin, startPos);
          }
        });
        if (startMin < Infinity && startMin >= 0) {
          textSrc = cutSrc.substring(0, startMin + 1);
        }
      }

      if ((token = lexer.tokenizer.inlineText(textSrc))) {
        cutSrc = cutSrc.substring(token.raw.length);
        if (token.raw.slice(-1) !== "_") prevChar = token.raw.slice(-1);
        keepPrevChar = true;
        const last = tokens[tokens.length - 1];
        if (last?.type === "text") {
          last.raw += token.raw;
          last.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (cutSrc) {
        const errMsg = "Infinite loop on byte: " + cutSrc.charCodeAt(0);
        if (lexer.options.silent) {
          console.error(errMsg);
          break;
        }
        throw new Error(errMsg);
      }
    }

    return tokens;
  }
}

// Block-lex `src` through FastLexer so its linear `inlineTokens` runs. marked's
// inherited static `Lexer.lex` instantiates the base Lexer (it closes over the
// class, not `this`), so a plain `FastLexer.lex` would bypass our override —
// hence this explicit instantiation.
// `options` is marked's `MarkedOptions`; typed loosely to sidestep its
// invariant `<ParserOutput, RendererOutput>` generics, which add no safety here.
export function fastLex(src: string, options?: any): Token[] {
  return new FastLexer(options).lex(src);
}

// A marked instance whose Lexer is the linear-masking FastLexer. Drop-in for
// `@tiptap/markdown`'s `Markdown.configure({ marked })`: the manager parses via
// `new markedInstance.Lexer().lex(...)` and lexes nested content via
// `markedInstance.lexer(...)`, both of which we route through FastLexer. Typed
// as `typeof marked` because that is the shape the extension's option expects.
//
// The top-level parse path constructs `new markedInstance.Lexer()` with NO
// options, so the bound Lexer must fall back to `instance.defaults` itself.
// Otherwise it lexes with marked's bare global defaults instead of this
// instance's configuration — which silently disables GFM extras like task
// lists, so `- [ ] x` degrades to a plain bullet whose `listItem` ends up with
// raw text instead of a wrapping paragraph (a schema-invalid node that throws
// the moment the user edits it). The nested `lexer(...)` path already forwards
// `instance.defaults`; binding the class keeps both paths in lockstep.
//
// `boundBlockTokenizers: false` and `rememberInlineStarts: false` exist for
// the equivalence tests, which need the same instance with only that
// optimization left out.
export function createFastMarked({ boundBlockTokenizers = true, rememberInlineStarts = true } = {}): typeof marked {
  const instance = new Marked();
  class BoundFastLexer extends FastLexer {
    constructor(options?: any) {
      super(options ?? (instance as any).defaults);
      this.rememberInlineStarts = rememberInlineStarts;
    }
  }
  (instance as any).Lexer = BoundFastLexer;
  (instance as any).lexer = (src: string, options?: any) =>
    new BoundFastLexer(options ?? (instance as any).defaults).lex(src);
  // Tiptap registers its markdown tokenizers through `use`; bound the block
  // tokenizers that would otherwise re-split the whole remaining document at
  // every block (see boundedBlockTokenizers.ts).
  let orderedListTokenizer: ((this: unknown, src: string, tokens: Token[]) => Tokens.List | undefined) | null = null;
  const use = instance.use.bind(instance);
  (instance as any).use = (...extensions: any[]) => use(...extensions.map((ext) => {
    if (!Array.isArray(ext?.extensions)) return ext;
    const bounded = (boundBlockTokenizers ? ext.extensions.map(boundBlockExtension) : ext.extensions)
      .map(withKnownInlineStart);
    const ordered = bounded.find((e: any) => e.name === "orderedList" && e.level === "block" && e.tokenizer);
    if (ordered) orderedListTokenizer = ordered.tokenizer;
    return { ...ext, extensions: bounded };
  }));
  // A blockquote whose last token is a list re-lexes that list, with the
  // quote's remaining lines appended, by calling the built-in `list` tokenizer
  // directly, and assumes it succeeds. A list from Tiptap's orderedList
  // extension ("a.", "iv.") is one the built-in tokenizer cannot read, so it
  // returns undefined and marked throws — "> q\na. x\n> q\na. x" could not be
  // opened. Re-lex such a list with the extension that produced it. Anywhere
  // else `list` is only reached after every block extension, orderedList
  // included, has already declined the same input, so the fallback declines
  // too and the built-in result is unchanged.
  instance.use({
    tokenizer: {
      list(src: string) {
        if (!orderedListTokenizer || (this as any).rules.block.list.test(src) || !MAYBE_ORDERED_ITEM.test(src)) {
          return false;
        }
        return orderedListTokenizer.call({ lexer: (this as any).lexer }, src, []) ?? false;
      },
    },
  });
  return instance as unknown as typeof marked;
}

// Tiptap's Underline starts with `src.indexOf("++")`; give it the equivalent
// firstIndexOf so FastLexer need not rescan the paragraph for it. Only that
// exact function is replaced (Tiptap passes it through unwrapped), so an
// extended Underline with its own start keeps it. fastMarkdownLexer.test.ts
// pins the equivalence against the installed Tiptap.
const TIPTAP_UNDERLINE_START = (Underline.config as { markdownTokenizer?: { start?: unknown } })
  .markdownTokenizer?.start;
const UNDERLINE_START = firstIndexOf("++");

function withKnownInlineStart(ext: any): any {
  return ext?.level === "inline" && ext.start !== undefined && ext.start === TIPTAP_UNDERLINE_START
    ? { ...ext, start: UNDERLINE_START }
    : ext;
}

export { FastLexer };
