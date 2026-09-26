import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import type { Node as PMNode, Mark as PMMark } from "@tiptap/pm/model";
import type { NoteDoc } from "../hooks/useNotesLoader";
import { createFastMarked } from "./fastMarkdownLexer";
import WikiLink, { findDocByTitle, findDocsByTitle, refreshWikiLinkDecorations } from "./WikiLink";

function doc(fileName: string): NoteDoc {
  return { id: fileName, fileName } as unknown as NoteDoc;
}

/** Note with an explicit id and creation time, for duplicate-title resolution. */
function dated(id: string, fileName: string, createdAt: number): NoteDoc {
  return { id, fileName, createdAt } as unknown as NoteDoc;
}

function makeEditor(content: string, docs: NoteDoc[]) {
  const editor = new Editor({
    extensions: [StarterKit, WikiLink],
    content,
  });
  editor.storage.wikiLink.docs = docs;
  refreshWikiLinkDecorations(editor);
  return editor;
}

// Collect the concatenated text covered by a wikiLink mark with the given target.
function wikiMarkedText(node: PMNode, target: string): string {
  let out = "";
  node.descendants((n) => {
    if (!n.isText) return;
    const mark = n.marks.find(
      (m: PMMark) => m.type.name === "wikiLink" && (m.attrs as { target: string }).target === target,
    );
    if (mark) out += n.text ?? "";
  });
  return out;
}

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("findDocByTitle", () => {
  it("matches by normalized title and returns null when absent", () => {
    const docs = [doc("Alpha"), doc("Beta")];
    expect(findDocByTitle(docs, "  alpha ")?.fileName).toBe("Alpha");
    expect(findDocByTitle(docs, "BETA")?.fileName).toBe("Beta");
    expect(findDocByTitle(docs, "Gamma")).toBeNull();
    expect(findDocByTitle(docs, "")).toBeNull();
  });

  it("normalizes Unicode titles and queries", () => {
    const docs = [doc("Café")];
    expect(findDocByTitle(docs, "Café")?.fileName).toBe("Café");
  });

  it("resolves duplicate titles by age, not by position in the docs array", () => {
    // `docs` is in sidebar sort order, so "first entry wins" meant editing one
    // of two same-titled notes (default sort: updated-desc) silently re-pointed
    // every [[Dup]] at it. Oldest-created wins instead, which no sort setting
    // and no edit can change.
    const older = dated("older", "Dup", 100);
    const newer = dated("newer", "Dup", 200);
    expect(findDocByTitle([newer, older], "dup")).toBe(older);
    expect(findDocByTitle([older, newer], "dup")).toBe(older);
  });

  it("breaks a same-timestamp tie deterministically by id", () => {
    const a = dated("a-id", "Dup", 100);
    const b = dated("b-id", "Dup", 100);
    expect(findDocByTitle([b, a], "dup")).toBe(a);
    expect(findDocByTitle([a, b], "dup")).toBe(a);
  });

  it("prefers a candidate grouped with the note the link lives in", () => {
    const older = dated("older", "Dup", 100);
    const newer = dated("newer", "Dup", 200);
    const source = dated("source", "Source", 50);
    const groups = [
      { id: "g1", name: "Project", noteIds: ["source", "newer"], collapsed: false, createdAt: 1 },
      { id: "g2", name: "Other", noteIds: ["older"], collapsed: false, createdAt: 1 },
    ];
    const docs = [older, newer, source];

    expect(findDocByTitle(docs, "Dup", { fromNoteId: "source", groups })).toBe(newer);
    // No group context, or a source note outside every group, keeps the
    // age-based answer.
    expect(findDocByTitle(docs, "Dup")).toBe(older);
    expect(findDocByTitle(docs, "Dup", { fromNoteId: "loose", groups })).toBe(older);
  });

  it("lists every candidate for a title in resolution order", () => {
    const older = dated("older", "Dup", 100);
    const newer = dated("newer", "Dup", 200);
    expect(findDocsByTitle([newer, older], "dup").map((d) => d.id)).toEqual(["older", "newer"]);
    expect(findDocsByTitle([newer, older], "missing")).toEqual([]);
  });

  it("reuses the cached lookup for the same docs array reference", () => {
    const docs = [doc("Foo")];
    expect(findDocByTitle(docs, "Foo")?.fileName).toBe("Foo");

    docs[0].fileName = "Bar";
    expect(findDocByTitle(docs, "Foo")?.fileName).toBe("Bar");
    expect(findDocByTitle(docs, "Bar")).toBeNull();

    const next = [...docs];
    expect(findDocByTitle(next, "Bar")?.fileName).toBe("Bar");
    expect(findDocByTitle(next, "Foo")).toBeNull();
  });
});

describe("missing-link decorations", () => {
  it("marks only links whose target is absent from docs", () => {
    const editor = makeEditor(
      '<p>see <span data-wiki-link="Alpha">Alpha</span> and <span data-wiki-link="Ghost">Ghost</span></p>',
      [doc("Alpha")],
    );
    active = editor;
    const missing = editor.view.dom.querySelectorAll(".wiki-link-missing");
    expect(missing.length).toBe(1);
    expect(missing[0].textContent).toBe("Ghost");
  });

  it("decorates a missing link inserted by a plain (non-forced) edit", () => {
    const editor = makeEditor("<p>start </p>", [doc("Alpha")]);
    active = editor;
    expect(editor.view.dom.querySelectorAll(".wiki-link-missing").length).toBe(0);

    // Insert a wiki-link run to a non-existent note via a normal docChanged
    // transaction; the narrowed recompute must pick it up without a refresh.
    const markType = editor.schema.marks.wikiLink;
    const tr = editor.state.tr.insert(
      editor.state.doc.content.size - 1,
      editor.schema.text("Ghost", [markType.create({ target: "Ghost" })]),
    );
    editor.view.dispatch(tr);

    const missing = editor.view.dom.querySelectorAll(".wiki-link-missing");
    expect(missing.length).toBe(1);
    expect(missing[0].textContent).toBe("Ghost");
  });

  it("keeps existing-link decorations correct after an unrelated edit", () => {
    const editor = makeEditor(
      '<p>x <span data-wiki-link="Ghost">Ghost</span></p>',
      [doc("Alpha")],
    );
    active = editor;
    expect(editor.view.dom.querySelectorAll(".wiki-link-missing").length).toBe(1);

    // Type plain text at the very start, far from the wiki link.
    editor.chain().focus().setTextSelection(1).insertContent("hello ").run();

    const missing = editor.view.dom.querySelectorAll(".wiki-link-missing");
    expect(missing.length).toBe(1);
    expect(missing[0].textContent).toBe("Ghost");
  });
});

describe("markdown serialization", () => {
  it("round-trips wiki-link marks as bracketed markdown", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        Markdown.configure({ marked: createFastMarked() }),
        WikiLink,
      ],
      content: "See [[Alpha]] and [[한글 노트]].",
      contentType: "markdown",
    } as ConstructorParameters<typeof Editor>[0]);
    active = editor;

    expect(wikiMarkedText(editor.state.doc, "Alpha")).toBe("Alpha");
    expect(wikiMarkedText(editor.state.doc, "한글 노트")).toBe("한글 노트");
    expect(editor.getMarkdown()).toContain("[[Alpha]]");
    expect(editor.getMarkdown()).toContain("[[한글 노트]]");
  });
});

describe("wiki-link atomicity backstop (appendTransaction)", () => {
  it("trims a wikiLink mark that leaked over text inserted at the run boundary", () => {
    const editor = makeEditor(
      '<p><span data-wiki-link="Alpha">Alpha</span></p>',
      [doc("Alpha")],
    );
    active = editor;
    const markType = editor.schema.marks.wikiLink;

    // Find the end position of the marked "Alpha" run, then insert "X" carrying
    // the same wikiLink mark, simulating a leak that handleTextInput missed.
    let runEnd = 0;
    editor.state.doc.descendants((n, pos) => {
      if (n.isText && n.marks.some((m) => m.type.name === "wikiLink")) {
        runEnd = pos + n.nodeSize;
      }
    });
    const tr = editor.state.tr.insert(
      runEnd,
      editor.schema.text("X", [markType.create({ target: "Alpha" })]),
    );
    editor.view.dispatch(tr);

    expect(editor.state.doc.textContent).toBe("AlphaX");
    // The backstop must strip the mark back to exactly the target text.
    expect(wikiMarkedText(editor.state.doc, "Alpha")).toBe("Alpha");
  });

  it("does not walk the whole document for plain typing outside wiki links", () => {
    const editor = makeEditor(
      '<p>start</p><p><span data-wiki-link="Alpha">Alpha</span></p>',
      [doc("Alpha")],
    );
    active = editor;

    const descendantsSpy = vi.spyOn(PMNodeClass.prototype, "descendants");
    try {
      editor.chain().focus().setTextSelection(1).insertContent("hello ").run();
      expect(descendantsSpy).not.toHaveBeenCalled();
    } finally {
      descendantsSpy.mockRestore();
    }
  });

  it("does not walk the whole document for cursor moves outside wiki links", () => {
    const editor = makeEditor(
      '<p>start</p><p><span data-wiki-link="Alpha">Alpha</span></p>',
      [doc("Alpha")],
    );
    active = editor;

    const descendantsSpy = vi.spyOn(PMNodeClass.prototype, "descendants");
    try {
      editor.commands.setTextSelection(2);
      expect(descendantsSpy).not.toHaveBeenCalled();
    } finally {
      descendantsSpy.mockRestore();
    }
  });
});
