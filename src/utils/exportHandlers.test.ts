import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cloneEditorContentForExport,
  pointAssetImagesAtFiles,
  removeExternalReferences,
  withoutExternalCss,
} from "./exportHandlers";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

function editorWith(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ProseMirror";
  el.innerHTML = html;
  return el;
}

describe("removeExternalReferences", () => {
  it.each([
    "//host/share/a.png",
    "\\\\host\\share\\a.png",
    "file://host/share/a.png",
    "file:///C:/Users/me/secret.png",
    "https://host/a.png",
    "/\\host/a.png",
    "relative/a.png",
  ])("drops an image at %s", (src) => {
    const el = editorWith("<p><img></p>");
    el.querySelector("img")!.setAttribute("src", src);

    expect(removeExternalReferences(el)).toBe(1);
    expect(el.querySelector("img")!.hasAttribute("src")).toBe(false);
  });

  it("keeps inline images and leaves asset images to the gate", () => {
    const asset = "http://noten-asset.localhost/C%3A%2Fn%2F.assets%2Fa.png";
    const el = editorWith(`<img src="data:image/gif;base64,R0lG"><img src="${asset}">`);

    expect(removeExternalReferences(el)).toBe(0);
    expect(el.querySelectorAll("img")[0].getAttribute("src")).toBe("data:image/gif;base64,R0lG");
    expect(el.querySelectorAll("img")[1].getAttribute("src")).toBe(asset);
  });

  it("drops what an SVG would load, and keeps its own references", () => {
    const el = editorWith(`<svg xmlns="http://www.w3.org/2000/svg">
      <image href="//host/a.png"></image>
      <image xlink:href="//host/b.png"></image>
      <use href="//host/c.svg#x"></use>
      <use href="#local"></use>
      <path fill="url(//host/d)" marker-end="url(#arrow)"></path>
      <rect filter="u\\72l(//host/e)"></rect>
      <style>@import "//host/f.css"; .a { fill: url(//host/g) }</style>
    </svg>`);

    expect(removeExternalReferences(el)).toBe(2);
    expect(el.innerHTML).not.toContain("host");
    expect(el.querySelector("use")).not.toBeNull();
    expect(el.querySelectorAll("use")[1].getAttribute("href")).toBe("#local");
    expect(el.querySelector("path")!.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(el.querySelector("style")).toBeNull();
  });

  it("drops a load hidden behind something that looks like a marker reference", () => {
    const el = editorWith("<span></span>");
    el.querySelector("span")!.setAttribute("style", "/*url(#35;*/background:url(//host/x.png)");

    removeExternalReferences(el);

    expect(el.innerHTML).not.toContain("host");
  });

  it("drops loading elements and attributes, and leaves links alone", () => {
    const el = editorWith(`
      <link rel="stylesheet" href="//host/a.css"><iframe src="//host/b"></iframe><base href="//host/">
      <img src="data:image/gif;base64,R0lG" srcset="//host/c 1x">
      <video poster="//host/d"></video>
      <div style="background: url(//host/e); color: red"></div>
      <span style="background: u\\72l(//host/f)"></span>
      <a href="https://example.com/page">link</a>`);

    removeExternalReferences(el);

    expect(el.innerHTML).not.toContain("host");
    expect(el.querySelector("div")!.getAttribute("style")).toContain("color: red");
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://example.com/page");
  });
});

describe("withoutExternalCss", () => {
  it.each([
    ['.a { background: url("//host/a") }', ".a { background: none }"],
    [".a { background: url(file://host/a) }", ".a { background: none }"],
    [".a { background: url( '\\\\host\\a' ) }", ".a { background: none }"],
    ['.a { background: url("\\2f\\2fhost") }', ".a { background: none }"],
    ['.a { background: image-set("//host/a" 1x) }', ".a { background: none }"],
    ['.a { background: -webkit-image-set(url("//host/a") 1x) }', ".a { background: none }"],
    ['@import url("//host/a.css"); .a { color: red }', " .a { color: red }"],
    [".a { background: url(#x;*/background:url(//host/a) }", ".a { background: none }"],
    ['.a { --b: "url(#"; background-image: url(//host/a) }', '.a { --b: "none }'],
    [".a { background: url(data:image/x;*/background:url(//host/a) }", ".a { background: none }"],
    [".a { background: URL(//host/a) }", ".a { background: none }"],
    [".a { --b: u\\72l(//host/a); background: var(--b) }", ""],
  ])("removes the load from %s", (css, expected) => {
    expect(withoutExternalCss(css)).toBe(expected);
  });

  it.each([
    ".a { color: red }",
    ".a { marker-end: url(#arrow) }",
    '.a { background: url("data:image/png;base64,AAAA") }',
    '.a { background: url("data:image/svg+xml,%3Csvg xmlns=%27a%27 /%3E") }',
    ".a { background: url(data:image/png;base64,AAAA) }",
    '.a { content: "\\201C" }',
  ])("keeps %s", (css) => {
    expect(withoutExternalCss(css)).toBe(css);
  });
});

describe("cloneEditorContentForExport", () => {
  it("unwraps search-match decorations but keeps their text", () => {
    const el = editorWith(
      '<p>find <span class="search-match">needle</span> and <span class="search-match-active">needle</span></p>',
    );
    const clone = cloneEditorContentForExport(el);

    expect(clone.querySelector(".search-match")).toBeNull();
    expect(clone.querySelector(".search-match-active")).toBeNull();
    expect(clone.textContent).toBe("find needle and needle");
  });

  it("keeps document markup and inline marks intact", () => {
    const el = editorWith(
      '<h1>Title</h1><p><strong>bold</strong> <em><span class="search-match">hit</span></em></p>',
    );
    const clone = cloneEditorContentForExport(el);

    expect(clone.querySelector("h1")?.textContent).toBe("Title");
    expect(clone.querySelector("strong")?.textContent).toBe("bold");
    expect(clone.querySelector("em")?.textContent).toBe("hit");
    expect(clone.querySelector(".search-match")).toBeNull();
  });

  it("unwraps nested decoration spans", () => {
    const el = editorWith(
      '<p><span class="search-match">outer <span class="search-match-active">inner</span></span></p>',
    );
    const clone = cloneEditorContentForExport(el);

    expect(clone.querySelectorAll("span").length).toBe(0);
    expect(clone.textContent).toBe("outer inner");
  });

  it("does not mutate the live editor DOM", () => {
    const el = editorWith('<p><span class="search-match">hit</span></p>');
    cloneEditorContentForExport(el);

    expect(el.querySelector(".search-match")).not.toBeNull();
  });
});

describe("pointAssetImagesAtFiles", () => {
  const assetUrl = (path: string) => `http://noten-asset.localhost/${encodeURIComponent(path)}`;

  beforeEach(() => {
    invokeMock.mockReset();
    // The Rust gate: the canonical (`\\?\`) path of a file it would serve, else null.
    invokeMock.mockImplementation(async (_cmd: string, { paths }: { paths: string[] }) =>
      paths.map((p) => (p.includes("/.assets/") && !p.includes("refused") ? "\\\\?\\" + p.replace(/\//g, "\\") : null)),
    );
  });

  it("points asset-protocol sources at the files the image gate allows", async () => {
    const el = editorWith(
      `<p><img src="${assetUrl("C:/notes/.assets/n/사진 1.jpg")}"><img src="data:image/gif;base64,R0lG"><img src="${assetUrl("C:/notes/.assets/n/refused.png")}"><img src="${assetUrl("C:/notes/x.png")}"></p>`,
    );

    expect(await pointAssetImagesAtFiles(el)).toBe(2);

    // One batched call; a URL that maps to no `.assets` path is asked as "",
    // which the gate refuses.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("note_image_files", {
      paths: ["C:/notes/.assets/n/사진 1.jpg", "C:/notes/.assets/n/refused.png", ""],
    });
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("file:///C:/notes/.assets/n/%EC%82%AC%EC%A7%84%201.jpg");
    expect(imgs[1].getAttribute("src")).toBe("data:image/gif;base64,R0lG");
    // Refused or unmapped images are dropped, never left as a URL for the
    // PDF renderer to request.
    expect(imgs[2].hasAttribute("src")).toBe(false);
    expect(imgs[3].hasAttribute("src")).toBe(false);
  });

  it("drops the asset images but keeps inline ones when the gate cannot be asked", async () => {
    invokeMock.mockRejectedValue(new Error("ipc down"));
    const el = editorWith(`<p><img src="${assetUrl("C:/notes/.assets/n/a.png")}"><img src="data:image/gif;base64,R0lG"></p>`);

    expect(await pointAssetImagesAtFiles(el)).toBe(1);
    expect(el.querySelectorAll("img")[0].hasAttribute("src")).toBe(false);
    expect(el.querySelectorAll("img")[1].getAttribute("src")).toBe("data:image/gif;base64,R0lG");
  });

  it("does not call the gate for a note without asset images", async () => {
    const el = editorWith('<p><img src="data:image/gif;base64,R0lG"></p>');
    expect(await pointAssetImagesAtFiles(el)).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
