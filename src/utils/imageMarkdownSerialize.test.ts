import { describe, it, expect } from "vitest";
import { serializeImageMarkdown } from "./imageMarkdownSerialize";

// The serialized string goes straight into the .md body (single source of
// truth). The bug class being pinned: unescaped user data in alt/title/src
// produced broken HTML/markdown that the next load parsed as garbage,
// leaking fragments into the note text.

function parseImgAttrs(html: string): Record<string, string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const img = doc.querySelector("img");
  expect(img, `expected a single <img> in: ${html}`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const attr of Array.from(img!.attributes)) out[attr.name] = attr.value;
  return out;
}

describe("serializeImageMarkdown — HTML branch (sized images)", () => {
  it("round-trips a double quote in alt through attribute escaping", () => {
    const html = serializeImageMarkdown({
      src: ".assets/n1/a.png",
      alt: 'He said "hi"',
      width: 300,
    });
    const attrs = parseImgAttrs(html);
    expect(attrs.alt).toBe('He said "hi"');
    expect(attrs.src).toBe(".assets/n1/a.png");
    expect(attrs.width).toBe("300");
  });

  it("round-trips angle brackets and ampersands in title", () => {
    const html = serializeImageMarkdown({
      src: "data:image/png;base64,AA==",
      alt: "a < b & c > d",
      title: '<script>"x"&y</script>',
      height: 50,
    });
    const attrs = parseImgAttrs(html);
    expect(attrs.alt).toBe("a < b & c > d");
    expect(attrs.title).toBe('<script>"x"&y</script>');
    // The escaped output must not introduce extra elements when parsed.
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.querySelectorAll("*").length).toBe(1);
  });

  it("emits exactly one well-formed img tag for adversarial alt text", () => {
    const html = serializeImageMarkdown({
      src: ".assets/n1/a.png",
      alt: '"/><img src=x onerror=alert(1)>',
      width: 10,
    });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = doc.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute("onerror")).toBeNull();
  });
});

describe("serializeImageMarkdown — markdown branch", () => {
  it("emits plain syntax when nothing needs escaping", () => {
    expect(serializeImageMarkdown({ src: ".assets/n1/a.png", alt: "cat" }))
      .toBe("![cat](.assets/n1/a.png)");
    expect(serializeImageMarkdown({ src: ".assets/n1/a.png", alt: "cat", title: "t" }))
      .toBe('![cat](.assets/n1/a.png "t")');
  });

  it("escapes bracket delimiters in alt", () => {
    expect(serializeImageMarkdown({ src: "a.png", alt: "x] hijack [y" }))
      .toBe("![x\\] hijack \\[y](a.png)");
  });

  it("escapes quotes in title", () => {
    expect(serializeImageMarkdown({ src: "a.png", alt: "a", title: 'say "hi"' }))
      .toBe('![a](a.png "say \\"hi\\"")');
  });

  it("wraps a destination containing spaces or parens in angle brackets", () => {
    expect(serializeImageMarkdown({ src: "my pic (1).png", alt: "a" }))
      .toBe("![a](<my pic (1).png>)");
  });

  it("percent-encodes angle brackets inside an angle-bracket destination", () => {
    const out = serializeImageMarkdown({ src: "we<i>rd (x).png", alt: "a" });
    expect(out).toBe("![a](<we%3Ci%3Erd (x).png>)");
  });
});
