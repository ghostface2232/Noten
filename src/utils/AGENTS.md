Invariants for shared utilities that carry their own rule: logical lines (the status bar's line count and Go to Line) and the export path. The persistence modules in this directory (`libraryStore`, `decomposedState`, `metadataIO`, `groupsIO`, `conflictBackup`, `reconcileFolder`, `recoveryJournal`) are governed by `src/hooks/AGENTS.md`, and the context-menu registry by `src/components/AGENTS.md`.

## Logical Lines

The status bar's line count, its caret row, and Go to Line all use the *logical line* defined in `src/utils/documentLines.ts`: one line per textblock plus one per newline character or hard break inside it. Keep the three readouts on the same definition — the number the status bar shows must be the number Go to Line accepts.

- Counting top-level blocks (`doc.childCount`) instead made a ten-item list and a twenty-line code block read as one line.
- A jump target goes through `selectionForLinePos`. A line that *is* a leaf block resolves to a block position, where `TextSelection.create` does not throw but yields a selection whose parent has no inline content, so the next keystroke inserts a stray paragraph. That fallback assumes every block leaf in the schema is selectable; a non-selectable block atom would silently jump to the wrong line.
- `buildLineIndex` sums per-node `{lines, chars, words}` cached by node identity, so a rebuild after an edit costs O(top-level blocks) plus the changed blocks' text. Still cache the index against `doc` identity (selection-only transactions reuse the node), never rebuild per caret move, and coalesce doc-change rebuilds to one per frame — both the status bar and Go to Line subscribe to every transaction. Character and word counts come from the same cached stats, which is exact because a word never spans a textblock boundary; taking them from `doc.textContent` both allocates a second copy of the document and fuses each block's last word to the next block's first.

## Note Export

- Markdown export writes `editor.getMarkdown()`; PDF export serializes the live editor DOM through headless Edge (`print_to_pdf`).
- The editor DOM also carries transient decorations, so PDF export must go through `cloneEditorContentForExport` (`src/utils/exportHandlers.ts`), which unwraps `.search-match` / `.search-match-active` spans on a *clone*. Without it an open find bar prints its highlights into the PDF. Add any future decoration class to `DECORATION_SELECTOR`.
