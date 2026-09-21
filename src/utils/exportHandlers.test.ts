import { describe, it, expect, vi } from "vitest";
import { cloneEditorContentForExport, inlineAssetImages } from "./exportHandlers";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith("missing.png")) throw new Error("not found");
    return new Uint8Array([1, 2, 3]);
  }),
  writeTextFile: vi.fn(),
}));

function editorWith(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ProseMirror";
  el.innerHTML = html;
  return el;
}

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

describe("inlineAssetImages", () => {
  const assetUrl = (path: string) => `http://noten-asset.localhost/${encodeURIComponent(path)}`;

  it("replaces asset-protocol sources with data URLs of the files", async () => {
    const el = editorWith(
      `<p><img src="${assetUrl("/notes/.assets/n/a.jpg")}"><img src="data:image/gif;base64,R0lG"><img src="${assetUrl("/notes/.assets/n/missing.png")}"></p>`,
    );

    await inlineAssetImages(el);

    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("data:image/jpeg;base64,AQID");
    expect(imgs[1].getAttribute("src")).toBe("data:image/gif;base64,R0lG");
    // A file that cannot be read is dropped rather than left as a URL the
    // PDF renderer cannot resolve.
    expect(imgs[2].hasAttribute("src")).toBe(false);
  });
});
