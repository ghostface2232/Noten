import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView, ViewMutationRecord } from "@tiptap/pm/view";

const MERMAID_LANGUAGE = "mermaid";
const MERMAID_RENDER_DELAY_MS = 120;
const MERMAID_FONT_FAMILY = '"JetBrains Mono", "Pretendard JP", "Segoe UI", monospace';
const MERMAID_FONT_SIZE_PX = "12px";
const EDGE_LABEL_PILL_PADDING_X = 6;
const EDGE_LABEL_PILL_PADDING_Y = 2;
const EDGE_LABEL_PILL_MIN_TRACK_MULTIPLIER = 3.8;
const EDGE_LABEL_PILL_MIN_WIDTH_PX = 56;
const EDGE_LABEL_PILL_MIN_SIDE_CAP_PX = 14;
const MERMAID_TOGGLE_ICON_UP = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10.53 7.22a.75.75 0 0 0-1.06 0L5.22 11.47a.75.75 0 1 0 1.06 1.06L10 8.81l3.72 3.72a.75.75 0 0 0 1.06-1.06l-4.25-4.25Z"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>';
const COPY_FEEDBACK_MS = 1000;
type MermaidApi = typeof import("mermaid")["default"];
type Rect = { x: number; y: number; width: number; height: number };

let mermaidInitialized = false;
let mermaidRenderCount = 0;
let mermaidApi: MermaidApi | null = null;
let mermaidApiPromise: Promise<MermaidApi> | null = null;
let mermaidFontsReadyPromise: Promise<void> | null = null;

function normalizeLanguage(language: unknown): string {
  return typeof language === "string" ? language.trim().toLowerCase() : "";
}

function isMermaidLanguage(language: unknown): boolean {
  return normalizeLanguage(language) === MERMAID_LANGUAGE;
}

async function ensureMermaidFontsReady() {
  if (mermaidFontsReadyPromise) {
    return mermaidFontsReadyPromise;
  }

  mermaidFontsReadyPromise = (async () => {
    const fontFaceSet = document.fonts;
    if (!fontFaceSet?.load) {
      return;
    }

    await Promise.allSettled([
      fontFaceSet.load(`${MERMAID_FONT_SIZE_PX} "JetBrains Mono"`),
      fontFaceSet.load(`${MERMAID_FONT_SIZE_PX} "Pretendard JP"`),
      fontFaceSet.ready,
    ]);
  })();

  return mermaidFontsReadyPromise;
}

async function getMermaid() {
  if (mermaidApi) {
    return mermaidApi;
  }

  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid").then((module) => module.default);
  }

  mermaidApi = await mermaidApiPromise;

  if (!mermaidInitialized) {
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      suppressErrorRendering: true,
      fontFamily: MERMAID_FONT_FAMILY,
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
      },
      themeVariables: {
        fontFamily: MERMAID_FONT_FAMILY,
        fontSize: MERMAID_FONT_SIZE_PX,
      },
    });
    mermaidInitialized = true;
  }

  return mermaidApi;
}

class MermaidCodeBlockView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;

  private node: ProseMirrorNode;
  private readonly preElement: HTMLPreElement;
  private readonly codeBody: HTMLDivElement;
  private readonly codeElement: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly previewElement: HTMLDivElement;
  private readonly errorElement: HTMLDivElement;
  private codeCollapsed = false;
  private renderToken = 0;
  private renderTimeout: number | null = null;
  private copyFeedbackTimeout: number | null = null;
  private lastRenderKey = "";

  constructor(node: ProseMirrorNode) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "noten-code-block";

    this.preElement = document.createElement("pre");
    this.codeBody = document.createElement("div");
    this.codeBody.className = "noten-mermaid-code-body";
    this.codeElement = document.createElement("code");
    this.codeBody.append(this.codeElement);
    this.preElement.append(this.codeBody);

    this.copyButton = document.createElement("button");
    this.copyButton.type = "button";
    this.copyButton.className = "noten-code-copy";
    this.copyButton.innerHTML = COPY_ICON;
    this.copyButton.setAttribute("aria-label", "Copy code");
    this.copyButton.setAttribute("title", "Copy code");
    this.copyButton.addEventListener("click", this.handleCopyClick);
    this.preElement.append(this.copyButton);

    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "noten-mermaid-code-toggle";
    this.toggleButton.innerHTML = MERMAID_TOGGLE_ICON_UP;
    this.toggleButton.addEventListener("click", this.handleToggleClick);
    this.toggleButton.addEventListener("keydown", this.handleToggleKeyDown);
    this.preElement.append(this.toggleButton);

    this.contentDOM = this.codeElement;

    this.previewElement = document.createElement("div");
    this.previewElement.className = "noten-mermaid-preview";
    this.previewElement.hidden = true;

    this.errorElement = document.createElement("div");
    this.errorElement.className = "noten-mermaid-error";
    this.errorElement.hidden = true;

    this.dom.append(this.preElement, this.previewElement, this.errorElement);

    this.syncStructureFromNode();
    this.scheduleRender(true);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) {
      return false;
    }

    this.node = node;
    this.syncStructureFromNode();
    this.applyEdgeLabelPillShapeToCurrentPreview();
    this.scheduleRender();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") {
      return false;
    }

    if (
      mutation.target === this.dom ||
      mutation.target === this.preElement ||
      mutation.target === this.codeBody ||
      this.copyButton.contains(mutation.target) ||
      this.toggleButton.contains(mutation.target)
    ) {
      return true;
    }

    return this.previewElement.contains(mutation.target) || this.errorElement.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Node)) {
      return false;
    }

    return this.copyButton.contains(target) || this.toggleButton.contains(target);
  }

  destroy() {
    this.renderToken += 1;
    this.clearRenderTimeout();
    if (this.copyFeedbackTimeout !== null) {
      window.clearTimeout(this.copyFeedbackTimeout);
    }
    this.copyButton.removeEventListener("click", this.handleCopyClick);
    this.toggleButton.removeEventListener("click", this.handleToggleClick);
    this.toggleButton.removeEventListener("keydown", this.handleToggleKeyDown);
  }

  private syncStructureFromNode() {
    const language = typeof this.node.attrs.language === "string" ? this.node.attrs.language : "";
    this.preElement.dataset.language = language;
    this.codeElement.className = language ? `language-${language}` : "";

    const isMermaid = isMermaidLanguage(language);
    this.dom.classList.toggle("is-mermaid", isMermaid);
    this.toggleButton.hidden = !isMermaid;
    if (!isMermaid) {
      this.setCodeCollapsed(false);
    } else {
      this.syncToggleButton();
    }

    if (!isMermaid) {
      this.previewElement.hidden = true;
      this.previewElement.innerHTML = "";
      this.errorElement.hidden = true;
      this.errorElement.textContent = "";
      this.lastRenderKey = "";
      this.clearRenderTimeout();
    }
  }

  private scheduleRender(force = false) {
    if (!isMermaidLanguage(this.node.attrs.language)) {
      return;
    }

    const source = this.node.textContent;
    const renderKey = `${normalizeLanguage(this.node.attrs.language)}\u0000${source}`;

    if (!force && renderKey === this.lastRenderKey) {
      this.applyEdgeLabelPillShapeToCurrentPreview();
      return;
    }

    this.lastRenderKey = renderKey;
    this.clearRenderTimeout();
    this.renderTimeout = window.setTimeout(() => {
      void this.renderPreview(source);
    }, MERMAID_RENDER_DELAY_MS);
  }

  private clearRenderTimeout() {
    if (this.renderTimeout === null) {
      return;
    }

    window.clearTimeout(this.renderTimeout);
    this.renderTimeout = null;
  }

  private readonly handleCopyClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(this.node.textContent).then(() => {
      this.copyButton.innerHTML = CHECK_ICON;
      this.copyButton.classList.add("is-copied");
      if (this.copyFeedbackTimeout !== null) {
        window.clearTimeout(this.copyFeedbackTimeout);
      }
      this.copyFeedbackTimeout = window.setTimeout(() => {
        this.copyButton.innerHTML = COPY_ICON;
        this.copyButton.classList.remove("is-copied");
        this.copyButton.classList.add("is-restoring");
        requestAnimationFrame(() => {
          setTimeout(() => this.copyButton.classList.remove("is-restoring"), 150);
        });
        this.copyFeedbackTimeout = null;
      }, COPY_FEEDBACK_MS);
    });
  };

  private readonly handleToggleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.setCodeCollapsed(!this.codeCollapsed);
  };

  private readonly handleToggleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.setCodeCollapsed(!this.codeCollapsed);
  };

  private setCodeCollapsed(next: boolean) {
    if (this.codeCollapsed === next) {
      return;
    }

    this.codeCollapsed = next;
    this.codeBody.classList.toggle("is-collapsed", next);
    this.syncToggleButton();
  }

  private syncToggleButton() {
    this.toggleButton.dataset.collapsed = this.codeCollapsed ? "true" : "false";
    this.toggleButton.setAttribute("aria-pressed", this.codeCollapsed ? "true" : "false");
    this.toggleButton.setAttribute("aria-label", this.codeCollapsed ? "Expand Mermaid source" : "Collapse Mermaid source");
    this.toggleButton.setAttribute("title", this.codeCollapsed ? "Expand Mermaid source" : "Collapse Mermaid source");
  }

  private applyEdgeLabelPillShape(svgElement: SVGSVGElement) {
    const edgeLabelGroups = svgElement.querySelectorAll<SVGGElement>(".edgeLabel");
    const svgNs = "http://www.w3.org/2000/svg";

    edgeLabelGroups.forEach((group) => {
      group.classList.remove("has-custom-pill");
      group.querySelectorAll<SVGElement>(".noten-edge-pill").forEach((pill) => pill.remove());

      const labelGroup = group.querySelector<SVGGElement>(".label") ?? group;
      const labelBox = this.resolveLabelBox(labelGroup, group);

      if (!labelBox) {
        return;
      }

      const contentWidth = labelBox.width;
      const contentHeight = labelBox.height;
      const pillHeight = contentHeight + EDGE_LABEL_PILL_PADDING_Y * 2;
      const desiredWidth = contentWidth + EDGE_LABEL_PILL_PADDING_X * 2;
      const minTrackWidth = Math.max(
        pillHeight * EDGE_LABEL_PILL_MIN_TRACK_MULTIPLIER,
        pillHeight + EDGE_LABEL_PILL_MIN_SIDE_CAP_PX * 2,
        EDGE_LABEL_PILL_MIN_WIDTH_PX,
      );
      const pillWidth = Math.max(desiredWidth, minTrackWidth);
      const pillX = labelBox.x - EDGE_LABEL_PILL_PADDING_X - (pillWidth - desiredWidth) / 2;
      const pillY = labelBox.y - EDGE_LABEL_PILL_PADDING_Y;
      const pillRadius = pillHeight / 2;

      this.clearLegacyEdgeLabelBackgrounds(group);

      const pill = document.createElementNS(svgNs, "rect");
      pill.setAttribute("class", "noten-edge-pill");
      pill.setAttribute("x", pillX.toFixed(2));
      pill.setAttribute("y", pillY.toFixed(2));
      pill.setAttribute("width", pillWidth.toFixed(2));
      pill.setAttribute("height", pillHeight.toFixed(2));
      pill.setAttribute("rx", pillRadius.toFixed(2));
      pill.setAttribute("ry", pillRadius.toFixed(2));
      group.insertBefore(pill, group.firstChild);
      group.classList.add("has-custom-pill");
    });
  }

  private resolveLabelBox(labelGroup: SVGGraphicsElement, group: SVGGraphicsElement): Rect | null {
    let labelBox: Rect | null = null;
    const contentCandidates = labelGroup.querySelectorAll<SVGGraphicsElement>("text, foreignObject");

    for (const target of contentCandidates) {
      const box = this.getBBoxInAncestorCoordsSafe(target, group);
      labelBox = this.mergeRects(labelBox, box);
    }

    if (labelBox) {
      return labelBox;
    }

    return this.getBBoxInAncestorCoordsSafe(labelGroup, group);
  }

  private clearLegacyEdgeLabelBackgrounds(group: SVGGraphicsElement) {
    const oldBackgrounds = group.querySelectorAll<SVGElement>(".noten-edge-pill, .labelBkg, .background, .label rect");
    oldBackgrounds.forEach((element) => element.remove());
  }

  private mergeRects(base: Rect | null, candidate: Rect | null): Rect | null {
    if (!candidate) {
      return base;
    }
    if (!base) {
      return candidate;
    }

    const minX = Math.min(base.x, candidate.x);
    const minY = Math.min(base.y, candidate.y);
    const maxX = Math.max(base.x + base.width, candidate.x + candidate.width);
    const maxY = Math.max(base.y + base.height, candidate.y + candidate.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private getBBoxInAncestorCoordsSafe(
    element: SVGGraphicsElement,
    ancestor: SVGGraphicsElement,
  ): Rect | null {
    try {
      const rect = this.getBBoxInAncestorCoords(element, ancestor);
      if (!this.isValidRect(rect)) {
        return null;
      }
      return rect;
    } catch {
      return null;
    }
  }

  private isValidRect(rect: Rect): boolean {
    return Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0;
  }

  private getBBoxInAncestorCoords(
    element: SVGGraphicsElement,
    ancestor: SVGGraphicsElement,
  ): Rect {
    const box = element.getBBox();
    const elementCtm = element.getCTM();
    const ancestorCtm = ancestor.getCTM();

    if (!elementCtm || !ancestorCtm) {
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    let ancestorInverse: DOMMatrix;
    try {
      ancestorInverse = ancestorCtm.inverse();
    } catch {
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    const toAncestor = ancestorInverse.multiply(elementCtm);
    const corners = [
      new DOMPoint(box.x, box.y),
      new DOMPoint(box.x + box.width, box.y),
      new DOMPoint(box.x, box.y + box.height),
      new DOMPoint(box.x + box.width, box.y + box.height),
    ].map((point) => point.matrixTransform(toAncestor));

    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  }

  private applyEdgeLabelPillShapeToCurrentPreview() {
    const svgElement = this.previewElement.querySelector("svg");
    if (!svgElement) {
      return;
    }
    this.applyEdgeLabelPillShape(svgElement);
  }

  private async renderPreview(source: string) {
    this.renderTimeout = null;

    const token = ++this.renderToken;

    if (!source.trim()) {
      this.previewElement.hidden = true;
      this.previewElement.innerHTML = "";
      this.errorElement.hidden = true;
      this.errorElement.textContent = "";
      return;
    }

    try {
      const mermaid = await getMermaid();
      await ensureMermaidFontsReady();
      mermaidRenderCount += 1;
      const renderId = `noten-mermaid-${mermaidRenderCount}`;
      const { svg, bindFunctions } = await mermaid.render(renderId, source);

      if (token !== this.renderToken) {
        return;
      }

      this.previewElement.innerHTML = svg;
      this.previewElement.hidden = false;
      const svgElement = this.previewElement.querySelector("svg");
      if (svgElement) {
        svgElement.classList.add("noten-mermaid-svg");
        this.applyEdgeLabelPillShape(svgElement);
        window.requestAnimationFrame(() => {
          if (token !== this.renderToken) {
            return;
          }
          this.applyEdgeLabelPillShapeToCurrentPreview();
        });
      }
      bindFunctions?.(this.previewElement);
      this.errorElement.hidden = true;
      this.errorElement.textContent = "";
    } catch (error) {
      if (token !== this.renderToken) {
        return;
      }

      this.previewElement.hidden = true;
      this.previewElement.innerHTML = "";
      this.errorElement.hidden = false;
      this.errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

export const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node }: NodeViewRendererProps) => new MermaidCodeBlockView(node);
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "pre",
      {
        ...HTMLAttributes,
        "data-language": node.attrs.language || "",
      },
      ["code", { class: node.attrs.language ? `language-${node.attrs.language}` : null }, 0],
    ];
  },
});

export default MermaidCodeBlock;
