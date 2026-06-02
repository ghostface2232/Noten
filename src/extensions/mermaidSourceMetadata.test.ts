import { describe, it, expect } from "vitest";
import {
  embedMermaidSourceInSvg,
  extractMermaidSourceFromSvg,
  MERMAID_METADATA_TAG,
} from "./mermaidSourceMetadata";

const SVG_NS = "http://www.w3.org/2000/svg";

function makeSvg(): SVGSVGElement {
  return document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
}

function serialize(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/** Embed `source`, serialize to a string, then read it back — the export→import path. */
function roundTrip(source: string): string | null {
  const svg = makeSvg();
  embedMermaidSourceInSvg(svg, source);
  return extractMermaidSourceFromSvg(serialize(svg));
}

describe("mermaidSourceMetadata", () => {
  it("round-trips a plain ASCII diagram source", () => {
    const source = "flowchart TD\n  A[Start] --> B[End]";
    expect(roundTrip(source)).toBe(source);
  });

  it("round-trips Korean labels and XML-special characters", () => {
    const source = 'flowchart LR\n  시작 --> "분기 & <판단>"\n  판단 -->|예| 종료';
    expect(roundTrip(source)).toBe(source);
  });

  it("embeds the source under a <metadata> element", () => {
    const svg = makeSvg();
    embedMermaidSourceInSvg(svg, "flowchart TD\n A-->B");
    const metadata = svg.querySelector("metadata");
    expect(metadata).not.toBeNull();
    expect(metadata?.firstElementChild?.localName).toBe(MERMAID_METADATA_TAG);
    // Inserted ahead of any diagram content so it survives viewBox/style edits.
    expect(svg.firstChild).toBe(metadata);
  });

  it("returns null for a plain SVG with no marker", () => {
    const plain = `<svg xmlns="${SVG_NS}"><rect width="10" height="10"/></svg>`;
    expect(extractMermaidSourceFromSvg(plain)).toBeNull();
  });

  it("returns null for malformed XML", () => {
    expect(extractMermaidSourceFromSvg("<svg><not closed")).toBeNull();
  });

  it("returns null when the marker holds only whitespace", () => {
    expect(roundTrip("   \n  ")).toBeNull();
  });
});
