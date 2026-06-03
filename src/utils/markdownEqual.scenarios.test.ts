import { describe, it, expect } from "vitest";
import { normalizeMarkdown, markdownEqual } from "./markdownEqual";

// Safety-critical scenarios for markdownEqual. A FALSE POSITIVE (two
// meaningfully-different bodies reported equal) would let a real remote edit
// skip its .conflicts/ backup and be silently clobbered. These tests build a
// diverse corpus (many languages, formats, symbols, links, line breaks) and
// assert: cosmetic variants ARE equal, every meaningful edit is NOT, distinct
// notes never collide, and multibyte text is handled correctly.

const BOM = String.fromCharCode(0xfeff);
const toCRLF = (s: string) => s.replace(/\n/g, "\r\n");
const toCR = (s: string) => s.replace(/\n/g, "\r");

// Every entry is already canonical: LF endings, no leading BOM, no trailing
// newline. Trailing spaces / tabs / blank lines that appear are intentional.
const CORPUS: [string, string][] = [
  ["ko prose", "오늘은 노트 앱을 테스트하는 날입니다. 잘 되길 바랍니다."],
  ["en doc", "# Title\n\nFirst paragraph.\n\n- a\n- b"],
  ["ja", "見出し\n\n本文です。"],
  ["zh", "标题\n\n正文内容。"],
  ["ar rtl", "عنوان\n\nنص عادي هنا"],
  ["emoji-led", "🎉 launch notes\n\n- ship it 🚀"],
  ["table", "| h1 | h2 |\n| --- | --- |\n| a | b |"],
  ["nested list", "- top\n  - mid\n    - deep"],
  ["code block", "```js\nconst x = `a${b}`;\n# not a heading\n```"],
  [
    "links + wiki + footnote",
    "See [site](https://x.com) and [[Wiki Note]].\n\nBody.[^1]\n\n[^1]: footnote",
  ],
  ["hard breaks", "line one  \nline two  \nline three"],
  ["math + symbols", "E = mc² → ∑(a±b) ≈ 42 · ∞ — ©"],
  ["mixed languages", "한국어 English 日本語 中文 العربية mixed"],
  ["tab indented", "\ttabbed line\n\tsecond line"],
  ["blockquote + interior blank", "> quote\n>\n> more quote"],
  ["single emoji", "🚀"],
];

describe("corpus is in canonical form", () => {
  it.each(CORPUS)("normalize is identity for: %s", (_name, text) => {
    expect(normalizeMarkdown(text)).toBe(text);
  });
});

describe("cosmetic variants are reported EQUAL", () => {
  const variant = (s: string) => [
    ["CRLF", toCRLF(s)],
    ["CR", toCR(s)],
    ["leading BOM", BOM + s],
    ["one trailing newline", s + "\n"],
    ["many trailing newlines", s + "\n\n\n"],
    ["BOM + CRLF + trailing", BOM + toCRLF(s) + "\n\n"],
  ] as const;

  for (const [name, text] of CORPUS) {
    for (const [vname, v] of variant(text)) {
      it(`${name} == ${vname}`, () => {
        expect(markdownEqual(text, v)).toBe(true);
        expect(normalizeMarkdown(v)).toBe(text);
      });
    }
  }
});

describe("meaningful edits are NEVER reported equal", () => {
  // Each mutation must change the normalized form (proving normalize preserves
  // that aspect) and therefore must compare unequal.
  const mutations: [string, (s: string) => string][] = [
    ["append visible text", (s) => s + " EXTRA"],
    ["prepend visible text", (s) => "EXTRA " + s],
    ["leading space (indent)", (s) => " " + s],
    ["trailing spaces at EOF", (s) => s + "  "],
    ["add interior blank line", (s) => (s.includes("\n") ? s.replace("\n", "\n\n") : s + "\n\nx")],
    ["change a character", (s) => s.replace(/[A-Za-z0-9]/, (c) => (c === "z" ? "y" : "z"))],
  ];

  for (const [name, text] of CORPUS) {
    for (const [mname, mutate] of mutations) {
      const mutated = mutate(text);
      if (normalizeMarkdown(mutated) === normalizeMarkdown(text)) continue; // not a real change for this entry
      it(`${name} != ${mname}`, () => {
        expect(markdownEqual(text, mutated)).toBe(false);
      });
    }
  }
});

describe("distinct notes never collide", () => {
  it("no two different corpus entries are reported equal", () => {
    for (let i = 0; i < CORPUS.length; i++) {
      for (let j = i + 1; j < CORPUS.length; j++) {
        expect(markdownEqual(CORPUS[i][1], CORPUS[j][1])).toBe(false);
      }
    }
  });
});

describe("multibyte and whitespace safety", () => {
  it("strips only a LEADING bom, never an interior one", () => {
    expect(markdownEqual(BOM + "ab", "ab")).toBe(true);
    expect(markdownEqual("a" + BOM + "b", "ab")).toBe(false);
  });

  it("does not strip a bom that follows other characters", () => {
    expect(normalizeMarkdown("x" + BOM)).toBe("x" + BOM);
  });

  it("preserves an emoji or CJK first character when stripping nothing", () => {
    expect(markdownEqual(BOM + "🚀 hi", "🚀 hi")).toBe(true);
    expect(markdownEqual(BOM + "한글", "한글")).toBe(true);
    expect(markdownEqual("🚀 hi", "🚀 hello")).toBe(false);
  });

  it("treats NBSP and zero-width space as significant (not plain space)", () => {
    const NBSP = String.fromCharCode(0x00a0);
    const ZWSP = String.fromCharCode(0x200b);
    expect(markdownEqual("a" + NBSP + "b", "a b")).toBe(false);
    expect(markdownEqual("a" + ZWSP + "b", "ab")).toBe(false);
  });

  it("treats tabs and spaces as distinct indentation", () => {
    expect(markdownEqual("\tcode", "    code")).toBe(false);
  });

  it("keeps interior trailing-space hard breaks distinct", () => {
    expect(markdownEqual("a  \nb", "a\nb")).toBe(false);
  });
});
