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
const MERMAID_TOGGLE_ICON_DOWN = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5.22 8.53a.75.75 0 0 1 1.06-1.06L10 11.19l3.72-3.72a.75.75 0 0 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.53Z"/></svg>';
type MermaidApi = typeof import("mermaid")["default"];

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
  private readonly codeElement: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly previewElement: HTMLDivElement;
  private readonly errorElement: HTMLDivElement;
  private codeCollapsed = false;
  private renderToken = 0;
  private renderTimeout: number | null = null;
  private lastRenderKey = "";

  constructor(node: ProseMirrorNode) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "noten-code-block";

    this.preElement = document.createElement("pre");
    this.codeElement = document.createElement("code");
    this.preElement.append(this.codeElement);

    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "noten-mermaid-code-toggle";
    this.toggleButton.addEventListener("mousedown", this.handleToggleMouseDown);
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

    if (this.toggleButton.contains(mutation.target)) {
      return true;
    }

    return this.previewElement.contains(mutation.target) || this.errorElement.contains(mutation.target);
  }

  destroy() {
    this.renderToken += 1;
    this.clearRenderTimeout();
    this.toggleButton.removeEventListener("mousedown", this.handleToggleMouseDown);
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

  private readonly handleToggleMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.setCodeCollapsed(!this.codeCollapsed);
  };

  private setCodeCollapsed(next: boolean) {
    if (this.codeCollapsed === next) {
      return;
    }

    this.codeCollapsed = next;
    this.dom.classList.toggle("is-code-collapsed", next);
    this.preElement.classList.toggle("is-code-collapsed", next);
    this.codeElement.hidden = next;
    this.syncToggleButton();
  }

  private syncToggleButton() {
    this.toggleButton.dataset.collapsed = this.codeCollapsed ? "true" : "false";
    this.toggleButton.innerHTML = this.codeCollapsed ? MERMAID_TOGGLE_ICON_DOWN : MERMAID_TOGGLE_ICON_UP;
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
      let labelBox: DOMRect | SVGRect | null = null;
      const contentCandidates = [
        ...Array.from(labelGroup.querySelectorAll<SVGGraphicsElement>("text, foreignObject")),
      ];

      for (const target of contentCandidates) {
        try {
          const box = this.getBBoxInAncestorCoords(target, group);
          if (Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0) {
            if (!labelBox) {
              labelBox = box;
            } else {
              const minX = Math.min(labelBox.x, box.x);
              const minY = Math.min(labelBox.y, box.y);
              const maxX = Math.max(labelBox.x + labelBox.width, box.x + box.width);
              const maxY = Math.max(labelBox.y + labelBox.height, box.y + box.height);
              labelBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY } as SVGRect;
            }
          }
        } catch {
          // Ignore non-measurable target.
        }
      }

      if (!labelBox) {
        try {
          const direct = this.getBBoxInAncestorCoords(labelGroup, group);
          if (Number.isFinite(direct.x) && Number.isFinite(direct.y) && direct.width > 0 && direct.height > 0) {
            labelBox = direct;
          }
        } catch {
          // Keep null and skip.
        }
      }

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

      for (const oldBg of Array.from(group.querySelectorAll<SVGElement>(".noten-edge-pill, .labelBkg, .background, .label rect"))) {
        oldBg.remove();
      }

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

  private getBBoxInAncestorCoords(
    element: SVGGraphicsElement,
    ancestor: SVGGraphicsElement,
  ): SVGRect {
    const box = element.getBBox();
    const elementCtm = element.getCTM();
    const ancestorCtm = ancestor.getCTM();

    if (!elementCtm || !ancestorCtm) {
      return box as SVGRect;
    }

    let ancestorInverse: DOMMatrix;
    try {
      ancestorInverse = ancestorCtm.inverse();
    } catch {
      return box as SVGRect;
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
    } as SVGRect;
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
