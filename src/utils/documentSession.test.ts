import { describe, it, expect } from "vitest";
import { sessionHoldsSource, signaturesForStore } from "./documentSession";

// Stand-ins for immutable ProseMirror docs: only identity matters.
const loaded = { id: "loaded" };
const edited = { id: "edited" };

// A note loaded from Markdown that does not serialize back to itself, such as
// a legacy `&nbsp;` table cell: its source and serialized signatures differ.
const SOURCE = "source-sig";
const SERIALIZED = "serialized-sig";

describe("signaturesForStore", () => {
  it("keeps the source signature beside the serialized one while the doc is unchanged", () => {
    const session = { state: { doc: loaded }, markdownSignatures: [SOURCE] };
    expect(signaturesForStore(session, loaded, SERIALIZED)).toEqual([SOURCE, SERIALIZED]);
  });

  it("does not duplicate a signature that serialization reproduces", () => {
    const session = { state: { doc: loaded }, markdownSignatures: [SOURCE] };
    expect(signaturesForStore(session, loaded, SOURCE)).toEqual([SOURCE]);
  });

  it("drops the source signature once the doc has been edited", () => {
    const session = { state: { doc: loaded }, markdownSignatures: [SOURCE] };
    expect(signaturesForStore(session, edited, SERIALIZED)).toEqual([SERIALIZED]);
  });

  it("signs from serialization alone when no session was recorded", () => {
    expect(signaturesForStore(undefined, loaded, SERIALIZED)).toEqual([SERIALIZED]);
  });
});

describe("sessionHoldsSource", () => {
  const session = { state: { doc: loaded }, markdownSignatures: [SOURCE] };

  it("matches the unchanged doc reopened from the same source", () => {
    expect(sessionHoldsSource(session, loaded, SOURCE)).toBe(true);
  });

  it("rejects different source Markdown or an edited doc", () => {
    expect(sessionHoldsSource(session, loaded, "other-sig")).toBe(false);
    expect(sessionHoldsSource(session, edited, SOURCE)).toBe(false);
    expect(sessionHoldsSource(undefined, loaded, SOURCE)).toBe(false);
  });
});
