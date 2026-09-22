import { describe, it, expect, beforeEach, vi } from "vitest";
import { cloneEditorContentForExport, pointAssetImagesAtFiles } from "./exportHandlers";

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
