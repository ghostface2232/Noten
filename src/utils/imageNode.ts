/**
 * An image is one of two node types: `image`, a block of its own, and
 * `inlineImage`, which shares a line with other content (see NotenImage.ts).
 * Anything that acts on "the image" rather than on its layout takes both.
 */
export function isImageNodeName(name: string): boolean {
  return name === "image" || name === "inlineImage";
}
