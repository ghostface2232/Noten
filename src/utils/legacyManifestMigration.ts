import type { NoteGroup, TrashedNote } from "../hooks/useNotesLoader";
import type { StoredGroup } from "./groupsIO";
import type { NoteMeta } from "./metadataIO";
import type { UiState } from "./uiStateIO";

export interface LegacyManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  customName?: boolean;
}

export interface LegacyManifest {
  version: 1;
  notes: LegacyManifestNote[];
  activeNoteId: string | null;
  groups?: NoteGroup[];
  trashedNotes?: TrashedNote[];
  imageAssetMigrationV1CompletedAt?: number;
}

export function decomposeLegacyManifest(
  manifest: LegacyManifest,
  machineId: string,
): { metas: NoteMeta[]; groups: StoredGroup[]; uiState: UiState } {
  const noteToGroup = new Map<string, string>();
  const groupCollapsed: Record<string, boolean> = {};
  const now = Date.now();

  const groups = (manifest.groups ?? []).map((group, index) => {
    groupCollapsed[group.id] = group.collapsed;
    for (const noteId of group.noteIds) noteToGroup.set(noteId, group.id);
    return {
      id: group.id,
      name: group.name,
      orderKey: index.toString(36).padStart(8, "0"),
      orderUpdatedAt: group.createdAt ?? now,
      updatedAt: group.createdAt ?? now,
      createdAt: group.createdAt ?? now,
    };
  });

  const metas: NoteMeta[] = [
    ...manifest.notes.map((note) => ({
      version: 2 as const,
      id: note.id,
      fileName: note.fileName,
      ...(note.customName ? { customName: true } : {}),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      groupId: noteToGroup.get(note.id) ?? null,
      lastWriterMachineId: machineId,
      imageAssetMigrationV1CompletedAt: manifest.imageAssetMigrationV1CompletedAt,
    })),
    ...(manifest.trashedNotes ?? []).map((note) => ({
      version: 2 as const,
      id: note.id,
      fileName: note.fileName,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      groupId: note.groupId,
      trashedAt: note.trashedAt,
      lastWriterMachineId: machineId,
      imageAssetMigrationV1CompletedAt: manifest.imageAssetMigrationV1CompletedAt,
    })),
  ];

  return {
    metas,
    groups,
    uiState: {
      activeNoteId: manifest.activeNoteId,
      lastOpenedNoteId: manifest.activeNoteId,
      groupCollapsed,
    },
  };
}
