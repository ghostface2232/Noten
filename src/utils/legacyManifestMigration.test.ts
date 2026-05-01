import { describe, expect, it } from "vitest";
import { decomposeLegacyManifest, type LegacyManifest } from "./legacyManifestMigration";

describe("decomposeLegacyManifest", () => {
  it("maps notes, trash, groups, collapsed state, and image migration marker", () => {
    const manifest: LegacyManifest = {
      version: 1,
      activeNoteId: "n1",
      imageAssetMigrationV1CompletedAt: 123,
      notes: [
        { id: "n1", filePath: "n1.md", fileName: "One", customName: true, createdAt: 1, updatedAt: 2 },
      ],
      trashedNotes: [
        {
          id: "n2",
          fileName: "Two",
          originalFilePath: "n2.md",
          trashFilePath: ".trash/n2.md",
          trashedAt: 3,
          groupId: "g1",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      groups: [
        { id: "g1", name: "Group", noteIds: ["n1"], collapsed: true, createdAt: 1 },
      ],
    };

    const result = decomposeLegacyManifest(manifest, "machine");

    expect(result.metas).toEqual([
      expect.objectContaining({
        id: "n1",
        customName: true,
        groupId: "g1",
        imageAssetMigrationV1CompletedAt: 123,
      }),
      expect.objectContaining({
        id: "n2",
        trashedAt: 3,
        groupId: "g1",
        imageAssetMigrationV1CompletedAt: 123,
      }),
    ]);
    expect(result.groups).toEqual([expect.objectContaining({ id: "g1", name: "Group" })]);
    expect(result.uiState).toEqual({
      activeNoteId: "n1",
      lastOpenedNoteId: "n1",
      groupCollapsed: { g1: true },
    });
  });
});
