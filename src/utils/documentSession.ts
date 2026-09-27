// A cached editor session is reused when the Markdown being opened has one of
// its signatures. Serializing a document does not always reproduce the Markdown
// it was parsed from: a legacy `&nbsp;` table cell is dropped on parse, and
// hand-aligned columns are re-padded. Signing a session only from its
// serialized form would therefore never match a note whose file has not been
// rewritten since, rejecting its cached state (cursor, selection, history) on
// every switch. So while the document is unchanged since it was loaded, the
// session keeps the signature of the Markdown it came from as well.
//
// ProseMirror documents are immutable, so "unchanged" is reference equality:
// any edit produces a new doc object.

export interface SignedSession<Doc> {
  state: { doc: Doc };
  markdownSignatures: readonly string[];
}

/** The signatures to store for `doc` when its session is left. */
export function signaturesForStore<Doc>(
  previous: SignedSession<Doc> | undefined,
  doc: Doc,
  serializedSignature: string,
): string[] {
  if (!previous || previous.state.doc !== doc) return [serializedSignature];
  return previous.markdownSignatures.includes(serializedSignature)
    ? [...previous.markdownSignatures]
    : [...previous.markdownSignatures, serializedSignature];
}

/** Whether `session` still holds `doc` as loaded from Markdown with `signature`. */
export function sessionHoldsSource<Doc>(
  session: SignedSession<Doc> | undefined,
  doc: Doc,
  signature: string,
): boolean {
  return !!session && session.state.doc === doc && session.markdownSignatures.includes(signature);
}
