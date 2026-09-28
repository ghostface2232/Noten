import CodeBlock from "@tiptap/extension-code-block";

type ParseCodeBlock = NonNullable<typeof CodeBlock.config.parseMarkdown>;
type RenderCodeBlock = NonNullable<typeof CodeBlock.config.renderMarkdown>;

// A fence may be indented by up to 3 spaces (CommonMark 4.5), and marked's
// `code` token for one keeps that indent in `raw`. The stock parseMarkdown
// accepts only a `raw` starting with the fence itself and returns nothing for
// any other, so an indented fence was deleted with its code on the first
// save: `p` / blank / `` ␠``` `` was saved as `p`, and so was a fence one
// column deeper than its list item's content. marked's `code` tokens are
// indented code (`codeBlockStyle: "indented"`) and fences, whose `raw` starts
// at the fence line, so this admits exactly the fences marked recognised.
const FENCE_OPEN = /^ {0,3}(?:```|~~~)/;

// CommonMark removes up to the fence's own indent from each content line.
// marked (17) does so for backtick fences only, so an indented `~~~` fence
// would add that indent to every line of its code on the first save.
const TILDE_FENCE_INDENT = /^( {1,3})~~~/;
const LEADING_SPACES = /^ */;

function compensateTildeFenceIndent(raw: string, text: string): string {
  const indent = raw.match(TILDE_FENCE_INDENT)?.[1].length;
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => line.slice(Math.min(indent, line.match(LEADING_SPACES)![0].length)))
    .join("\n");
}

/**
 * CodeBlock's parseMarkdown, keeping a fence indented by up to 3 spaces and
 * removing a tilde fence's indent from its lines.
 */
export const parseCodeBlockMarkdown: ParseCodeBlock = (token, helpers) => {
  if (typeof token.raw === "string" && !FENCE_OPEN.test(token.raw) && token.codeBlockStyle !== "indented") return [];
  const text =
    typeof token.raw === "string" && typeof token.text === "string"
      ? compensateTildeFenceIndent(token.raw, token.text)
      : token.text;
  return helpers.createNode("codeBlock", { language: token.lang || null }, text ? [helpers.createTextNode(text)] : []);
};

// A line of 3+ backticks after 0-3 spaces, the start of any line that could
// close a backtick fence (CommonMark 4.5: at least as long as the opening
// fence, no info string after it).
const BACKTICK_RUN_AT_LINE_START = /^ {0,3}(`{3,})/gm;

/**
 * CodeBlock's renderMarkdown, with a fence one backtick longer than the
 * longest backtick run starting any line of the code.
 *
 * The stock renderer always writes three backticks, so code holding a line of
 * ``` (or longer, or after up to 3 spaces) closed the block there on the next
 * load: `a` / ``` / `b` saved as a block holding `a`, and the rest of the code
 * read as Markdown. A run followed by other text (```js) cannot close the
 * fence but still lengthens it, which is harmless; a ~~~ line or a run 4
 * spaces in is not counted. Code with no line starting in 3 backticks after
 * 0-3 spaces keeps the stock three, byte for byte.
 */
export const renderCodeBlockMarkdown: RenderCodeBlock = (node, h) => {
  const language = node.attrs?.language || "";
  if (!node.content) return `\`\`\`${language}\n\n\`\`\``;
  const code = h.renderChildren(node.content);
  let longest = 2;
  for (const match of code.matchAll(BACKTICK_RUN_AT_LINE_START)) longest = Math.max(longest, match[1].length);
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, code, fence].join("\n");
};

/** The kit's code block, for editors that do not use MermaidCodeBlock. */
export const NotenCodeBlock = CodeBlock.extend({
  parseMarkdown: parseCodeBlockMarkdown,
  renderMarkdown: renderCodeBlockMarkdown,
});
