import { describe, it, expect } from "vitest";
import { isProbablyMarkdown } from "./isProbablyMarkdown";

// Scenario coverage for the paste-detection heuristic across many languages,
// formats, symbols, and link shapes. False positives mangle pasted prose/code;
// false negatives paste markdown as literal text. Both are paste-only and
// undoable, so these assert sensible classification rather than a hard safety
// invariant.

describe("real Markdown is detected across languages", () => {
  const markdown: [string, string][] = [
    ["english headings", "# Title\n\nSome intro.\n\n## Section\n\nText."],
    ["korean headings + list", "# 제목\n\n- 첫 번째\n- 두 번째\n- 세 번째"],
    ["japanese headings", "## 見出し\n\n本文の段落です。"],
    ["chinese task list", "- [ ] 任务一\n- [x] 任务二"],
    ["arabic blockquote", "> هذا اقتباس\n\nنص عادي"],
    ["table", "| 이름 | 나이 |\n| --- | --- |\n| 철수 | 30 |"],
    ["fenced code", "```python\nprint('hello')\n```"],
    ["image", "![고양이](./assets/cat.png)"],
    ["lone inline link", "[Anthropic](https://anthropic.com)"],
    ["lone link with trailing newline", "[docs](https://x.dev/docs)\n"],
    ["nested list", "- parent\n  - child\n  - child2\n- sibling"],
    ["ordered list mixed lang", "1. 항목 하나\n2. item two\n3. 三"],
    ["thematic break doc", "Intro\n\n---\n\nAfter the rule"],
    ["mixed rich note", "# 회의록\n\n**중요**: [링크](https://a.b) 참고\n\n- 할 일\n- `코드`"],
  ];
  it.each(markdown)("detects: %s", (_name, text) => {
    expect(isProbablyMarkdown(text)).toBe(true);
  });
});

describe("plain prose is NOT treated as Markdown", () => {
  const prose: [string, string][] = [
    ["english", "This is a normal sentence without any structure at all."],
    ["korean", "이것은 아무런 마크다운 서식이 없는 평범한 문장입니다."],
    ["japanese", "これは特別な書式のない普通の文章です。"],
    ["chinese", "这是一段没有任何格式的普通文字。"],
    ["arabic", "هذه جملة عادية بدون أي تنسيق خاص على الإطلاق."],
    ["prose with one inline link", "Please see [our site](https://x.com) for details."],
    ["prose with one star", "I gave it 4 * 5 stars overall, not bad."],
    ["prose with underscore word", "The file is named my_report_final today."],
    ["emoji line", "🎉 축하해요! 오늘 정말 즐거운 하루였어요 😀"],
    ["currency and symbols", "Total: $30 + €20 = about 50 (≈ 70%) © 2026"],
  ];
  it.each(prose)("rejects: %s", (_name, text) => {
    expect(isProbablyMarkdown(text)).toBe(false);
  });
});

describe("structured non-Markdown is NOT treated as Markdown", () => {
  const other: [string, string][] = [
    ["json object", '{\n  "name": "x",\n  "list": ["a", "b"],\n  "n": 1\n}'],
    ["csv", "name,age,city\njohn,30,nyc\njane,25,sf"],
    ["python code", "def foo(x):\n    return x * 2  # double it"],
    ["js code", "const a = arr[0];\nconsole.log(a, obj.key);"],
    ["windows path", "C:\\Users\\me\\Documents\\notes\\todo.txt"],
    ["log lines", "2026-06-03 12:00:01 INFO started\n2026-06-03 12:00:02 WARN slow"],
    ["bare email", "someone.name@example.co.uk"],
    ["bare url", "https://example.com/a/b?c=d&e=f"],
    ["email headers", "From: a@b.com\nTo: c@d.com\nSubject: Re: hi\n\nThanks."],
    ["html", "<section><p>Hello <strong>world</strong></p></section>"],
  ];
  it.each(other)("rejects: %s", (_name, text) => {
    expect(isProbablyMarkdown(text)).toBe(false);
  });
});

describe("edge cases", () => {
  it("rejects empty / whitespace", () => {
    expect(isProbablyMarkdown("")).toBe(false);
    expect(isProbablyMarkdown("   ")).toBe(false);
    expect(isProbablyMarkdown("\n\n\t  \n")).toBe(false);
  });
  it("does not treat a single word as Markdown", () => {
    expect(isProbablyMarkdown("hello")).toBe(false);
    expect(isProbablyMarkdown("안녕하세요")).toBe(false);
  });
});
