/**
 * Round-trip metadata for Mermaid diagram exports.
 *
 * On SVG export we stash the original Mermaid source inside the SVG's
 * <metadata> element (under a private namespace). When such an SVG is later
 * brought back into the editor we read that source out and restore an editable
 * Mermaid code block instead of inserting a flat image.
 *
 * The source is carried as element text content rather than a hand-built
 * string: XMLSerializer escapes `<`, `&`, and quotes on write and DOMParser
 * unescapes them on read, so arbitrary diagram text (including Korean labels)
 * survives the round trip untouched.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Private namespace so our marker can never collide with real SVG content. */
export const MERMAID_METADATA_NS = "https://noten.app/ns/mermaid-source";
export const MERMAID_METADATA_TAG = "mermaidSource";
export const MERMAID_METADATA_VERSION = "1";

/**
 * Embed `source` into `svgEl` as a <metadata> entry. Mutates the passed
 * element (expected to be the export clone, not the live diagram).
 */
export function embedMermaidSourceInSvg(svgEl: SVGSVGElement, source: string): void {
  const metadata = svgEl.ownerDocument.createElementNS(SVG_NS, "metadata");
  const marker = svgEl.ownerDocument.createElementNS(MERMAID_METADATA_NS, MERMAID_METADATA_TAG);
  marker.setAttribute("version", MERMAID_METADATA_VERSION);
  marker.textContent = source;
  metadata.appendChild(marker);
  svgEl.insertBefore(metadata, svgEl.firstChild);
}

/**
 * Extract the embedded Mermaid source from a serialized SVG string, or null if
 * the SVG carries no marker (a plain image) or fails to parse. Never throws.
 */
export function extractMermaidSourceFromSvg(svgText: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  } catch {
    return null;
  }

  // DOMParser reports malformed XML as a <parsererror> node rather than throwing.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return null;
  }

  let marker = doc.getElementsByTagNameNS(MERMAID_METADATA_NS, MERMAID_METADATA_TAG)[0] as
    | Element
    | undefined;

  // Liberal fallback: match by local name in case a serializer dropped the
  // namespace (e.g. an SVG round-tripped through an optimizer).
  if (!marker) {
    marker = Array.from(doc.getElementsByTagName("*")).find(
      (el) => el.localName === MERMAID_METADATA_TAG,
    );
  }

  const source = marker?.textContent;
  return source && source.trim().length > 0 ? source : null;
}
