import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { common, createLowlight } from "lowlight";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import MermaidCodeBlock from "./MermaidCodeBlock";
import NotenTaskList from "./NotenTaskList";
import { createNotenTaskItem } from "./NotenTaskItem";
import { NotenOrderedList } from "./NotenOrderedList";
import { tokenizeOrderedList as parentTokenize } from "./zzReviewParent";
import * as fs from "fs";

const lowlight = createLowlight(common);
export const OUT = "C:/Users/WellCalm/AppData/Local/Temp/claude/C--Users-WellCalm-OneDrive----00-AI-Noten--claude-worktrees-busy-herschel-deaaf9/a094be6a-47dc-4414-9c30-a65b554027a5/scratchpad/";
export function log(file: string, s: string) { fs.appendFileSync(OUT + file, s + "\n"); }

const ParentOL = NotenOrderedList.extend({
  markdownTokenizer: { ...(NotenOrderedList.config as any).markdownTokenizer, tokenize: parentTokenize },
});

export function makeEditor(md: string, parent = false): Editor {
  return new Editor({
    extensions: [
      NotenStarterKit.configure({ codeBlock: false, underline: false, link: false, ...(parent ? { orderedList: false } : {}) }),
      ...(parent ? [ParentOL] : []),
      MermaidCodeBlock.configure({ lowlight }),
      NotenTaskList,
      createNotenTaskItem(() => "en"),
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
    ],
    content: md,
    contentType: "markdown",
  } as any);
}
export function save(md: string, parent = false): string {
  const e = makeEditor(md, parent);
  try { return e.getMarkdown().trimEnd(); } finally { e.destroy(); }
}
export function codes(md: string, parent = false): string[] {
  const e = makeEditor(md, parent);
  const out: string[] = [];
  const visit = (n: JSONContent) => { if (n.type === "codeBlock") out.push((n.content ?? []).map(c => c.text ?? "").join("")); n.content?.forEach(visit); };
  visit(e.getJSON()); e.destroy();
  return out;
}
