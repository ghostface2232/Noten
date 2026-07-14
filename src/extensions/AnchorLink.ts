import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { extractHeadings } from "../utils/outline";
import { resolveHeadingFragment } from "../utils/headingSlug";

export interface AnchorLinkStorage {
  /** Jump to a heading node pos — same coordinate handleOutlineJump takes. */
  onJump: (pos: number) => void;
  /** A "#fragment" link resolved to no heading in the current document. */
  onMissing: () => void;
}

export const ANCHOR_LINK_PLUGIN_KEY = new PluginKey("anchorLink");

/**
 * Click handling for internal "#fragment" links (link marks whose href starts
 * with "#"): resolves the fragment against the document's headings and jumps,
 * or reports a missing target. Resolution walks the document only at click
 * time — never per transaction.
 */
const AnchorLink = Extension.create<unknown, AnchorLinkStorage>({
  name: "anchorLink",

  addStorage(): AnchorLinkStorage {
    return {
      onJump: () => {},
      onMissing: () => {},
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    return [
      new Plugin({
        key: ANCHOR_LINK_PLUGIN_KEY,
        props: {
          handleClick: (view, _pos, event) => {
            if (event.button !== 0) return false;
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
              return false;
            }

            const domTarget = event.target as HTMLElement | null;
            const anchorEl = domTarget?.closest("a");
            if (!anchorEl || !view.dom.contains(anchorEl)) return false;

            // The raw attribute — anchorEl.href resolves against the base URL
            // and would never start with "#".
            const href = anchorEl.getAttribute("href") ?? "";
            if (!href.startsWith("#")) return false;

            // Handled either way: falling through on a miss would let the
            // WebView attempt real "#" navigation.
            event.preventDefault();
            const hit = resolveHeadingFragment(extractHeadings(view.state.doc), href);
            if (hit) {
              extension.storage.onJump(hit.pos);
            } else {
              extension.storage.onMissing();
            }
            return true;
          },
        },
      }),
    ];
  },
});

export default AnchorLink;
