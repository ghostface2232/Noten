/**
 * Fixed note color palette (Finder-style, 7 colors). Single source of truth —
 * imported by both metadata IO and UI so there is no dependency cycle.
 */

export type NoteColorId =
  | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";

export interface NoteColorDef {
  id: NoteColorId;
  /** Icon-tint color — chosen to stay readable on light and dark sidebars. */
  hex: string;
}

export const NOTE_COLORS: NoteColorDef[] = [
  { id: "red",    hex: "#E5484D" },
  { id: "orange", hex: "#F2740B" },
  { id: "yellow", hex: "#D9A800" },
  { id: "green",  hex: "#30A46C" },
  { id: "blue",   hex: "#3B82F6" },
  { id: "purple", hex: "#8E4EC6" },
  { id: "pink",   hex: "#E93D82" },
];

const HEX_BY_ID = new Map<NoteColorId, string>(NOTE_COLORS.map((c) => [c.id, c.hex]));

/** Resolve a color id to its hex value. Returns undefined for no/unknown color. */
export function colorHex(id: NoteColorId | null | undefined): string | undefined {
  return id ? HEX_BY_ID.get(id) : undefined;
}

/** Type guard — used to validate values loaded from settings/metadata files. */
export function isNoteColorId(v: unknown): v is NoteColorId {
  return typeof v === "string" && HEX_BY_ID.has(v as NoteColorId);
}
