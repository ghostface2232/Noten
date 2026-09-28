import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import StarterKit from "@tiptap/starter-kit";
import { NotenOrderedList } from "./NotenOrderedList";
import { NotenCodeBlock } from "./codeBlockMarkdown";

// Inline code whose text holds a backtick needs a longer fence: CommonMark
// closes a code span at the first backtick run as long as the opener, so the
// stock `` `a`b` `` reparses as code `a`, the text `b`, and a stray backtick.
//
// @tiptap/markdown never shows a mark renderer its text. It renders the mark
// once around a placeholder and splits the result into an opening and a
// closing delimiter, passing only the mark's attrs. So CodeSpanFence hooks the
// manager's `renderNodes` — every inline run reaches the mark-boundary
// serializer through it — and annotates the code mark of each run that needs
// more than one backtick with the fence to use. NotenCode's renderer reads it
// back. Runs that need a single backtick are passed through untouched, so
// their output stays byte-identical to the stock serializer.

const FENCE_ATTR = "markdownFence";
const PAD_ATTR = "markdownPad";

export interface CodeSpanDelimiters {
  fence: string;
  pad: boolean;
}

/**
 * The CommonMark delimiters for a code span holding `content`: one backtick
 * more than its longest backtick run, and a space inside each side when the
 * content starts or ends with a backtick (it would merge into the fence), or
 * starts and ends with a space around other text (a reader strips one each).
 */
export function codeSpanFence(content: string): CodeSpanDelimiters {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const pad =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content));
  return { fence: "`".repeat(longest + 1), pad };
}

function hasCodeMark(node: JSONContent): boolean {
  return node.marks?.some((mark) => mark.type === "code") ?? false;
}

function withFence(node: JSONContent, attrs: Record<string, unknown>): JSONContent {
  return {
    ...node,
    marks: node.marks!.map((mark) => (mark.type === "code" ? { ...mark, attrs } : mark)),
  };
}

/**
 * Annotate the code mark of every run that needs a longer fence or padding.
 * A run is the consecutive nodes carrying the code mark: the serializer keeps
 * the mark open across them, so they share one pair of delimiters. Returns
 * `nodes` itself when nothing needs annotating.
 */
export function annotateCodeSpanFences(nodes: JSONContent[]): JSONContent[] {
  let out: JSONContent[] | null = null;
  let i = 0;
  while (i < nodes.length) {
    if (!hasCodeMark(nodes[i])) {
      i += 1;
      continue;
    }
    let end = i;
    let text = "";
    while (end < nodes.length && hasCodeMark(nodes[end])) {
      if (nodes[end].type === "text") text += nodes[end].text ?? "";
      end += 1;
    }
    // The serializer moves a run's leading and trailing whitespace outside the
    // delimiters, so only the trimmed text ever sits next to the fence.
    const { fence, pad } = codeSpanFence(text.replace(/^\s+/, "").replace(/\s+$/, ""));
    if (fence.length > 1 || pad) {
      out ??= nodes.slice();
      for (let k = i; k < end; k += 1) {
        const codeMark = nodes[k].marks!.find((mark) => mark.type === "code")!;
        out[k] = withFence(nodes[k], { ...codeMark.attrs, [FENCE_ATTR]: fence, [PAD_ATTR]: pad });
      }
    }
    i = end;
  }
  return out ?? nodes;
}

// The schema ranks marks by extension priority, then order, and the Markdown
// serializer nests a node's marks by that rank, lowest outermost. The stock
// code mark ranks right after bold, so italic, strike, underline and wiki
// links opened inside it and `` *`a`* `` saved as `` `*a*` ``, whose asterisks
// are code text on reload. One below the default priority makes code the
// last mark and so always the innermost: code content cannot hold formatting.
export const NotenCode = Code.extend({
  priority: 99,

  renderMarkdown: (node, h) => {
    if (!node.content) return "";
    const fence = typeof node.attrs?.[FENCE_ATTR] === "string" ? node.attrs[FENCE_ATTR] : "`";
    const pad = node.attrs?.[PAD_ATTR] === true ? " " : "";
    return `${fence}${pad}${h.renderChildren(node.content)}${pad}${fence}`;
  },
});

const NOTEN_REPLACEMENTS: Record<string, { configure(options: never): unknown }> = {
  code: NotenCode,
  codeBlock: NotenCodeBlock,
  orderedList: NotenOrderedList,
};

export const NotenStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      const replacement = NOTEN_REPLACEMENTS[extension.name];
      return replacement ? (replacement.configure(extension.options as never) as typeof extension) : extension;
    });
  },
});

interface RenderNodesManager {
  renderNodes(nodeOrNodes: JSONContent | JSONContent[], ...rest: unknown[]): string;
}

const installed = new WeakSet<object>();

function install(editor: Editor): void {
  const manager = editor.markdown as unknown as RenderNodesManager | undefined;
  if (!manager || installed.has(manager)) return;
  installed.add(manager);
  const renderNodes = manager.renderNodes.bind(manager);
  manager.renderNodes = (nodeOrNodes, ...rest) =>
    renderNodes(Array.isArray(nodeOrNodes) ? annotateCodeSpanFences(nodeOrNodes) : nodeOrNodes, ...rest);
}

export const CodeSpanFence = Extension.create({
  name: "codeSpanFence",

  // Must follow the Markdown extension, which creates the manager in its own
  // onBeforeCreate; onCreate covers an order where it had not run yet.
  onBeforeCreate() {
    install(this.editor);
  },

  onCreate() {
    install(this.editor);
  },
});

export default CodeSpanFence;
