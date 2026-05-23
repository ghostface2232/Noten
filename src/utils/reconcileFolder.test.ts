import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import {
  reconcileFolder,
  createReconcileState,
  type ReconcileState,
} from "./reconcileFolder";
import {
  writeMeta,
  readMeta,
  ensureMetaDir,
  metaPathFor,
  type NoteMeta,
} from "./metadataIO";
import type { NoteDoc, NoteGroup } from "../hooks/useNotesLoader";

const DIR = "/notes";
const LOCALE = "en" as const;
const MACHINE = "test-machine";

function makeMeta(id: string, overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    version: 2,
    id,
    fileName: id,
    createdAt: 1000,
    updatedAt: 1000,
    groupId: null,
    trashedAt: null,
    ...overrides,
  };
}

function makeDoc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    filePath: `${DIR}/${id}.md`,
    fileName: id,
    isDirty: false,
    content: "",
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    ...overrides,
  };
}

async function seedMeta(fs: InMemoryFileSystem, meta: NoteMeta): Promise<void> {
  await ensureMetaDir(fs, DIR);
  await writeMeta(fs, DIR, meta, MACHINE);
}

let fs: InMemoryFileSystem;
let state: ReconcileState;

beforeEach(() => {
  fs = createInMemoryFileSystem();
  state = createReconcileState();
  fs.seedDir(DIR);
});

describe("reconcileFolder", () => {
  it("picks up a new .md file and creates its meta sidecar", async () => {
    fs.seedTextFile(`${DIR}/note-alpha.md`, "# Hello\n");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].id).toBe("note-alpha");
    expect(result.docs[0].content).toBe("# Hello\n");

    const written = await readMeta(fs, DIR, "note-alpha");
    expect(written).not.toBeNull();
    expect(written!.fileName).toBe("Hello");
  });

  it("graces a bodyless meta on the first pass and removes it on the second", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await seedMeta(fs, makeMeta(id));

    const first = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(first.changed).toBe(false);
    expect(state.bodyMissing.get(id)).toBe(1);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    const second = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(second.changed).toBe(false);
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(false);
  });

  it("skips bodyless deletion when bulk guard trips (>=3 ids and >=25%)", async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${i.toString().padStart(12, "0")}`;
      await seedMeta(fs, makeMeta(id));
      if (i >= 3) {
        fs.seedTextFile(`${DIR}/${id}.md`, `body ${i}`);
      }
    }

    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    for (let i = 0; i < 3; i += 1) {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${i.toString().padStart(12, "0")}`;
      expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);
    }
  });

  it("restores trashed note when root mtime is newer than trashedAt", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const trashedAt = 5000;
    await seedMeta(fs, makeMeta(id, { trashedAt, trashedFromPath: `${DIR}/${id}.md` }));
    // Root body present and newer than trashedAt.
    fs.seedTextFile(`${DIR}/${id}.md`, "restored content");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    const meta = await readMeta(fs, DIR, id);
    expect(meta).not.toBeNull();
    expect(meta!.trashedAt).toBeNull();
    expect(await fs.exists(`${DIR}/.trash/${id}.md`)).toBe(false);
  });

  it("moves root body to trash when trashedAt is newer than root mtime", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    fs.seedTextFile(`${DIR}/${id}.md`, "stale root");

    // Stat the file we just seeded so trashedAt can be set well in the future.
    const rootStat = await fs.stat(`${DIR}/${id}.md`);
    const rootMtime = rootStat.mtime!.getTime();
    await seedMeta(fs, makeMeta(id, { trashedAt: rootMtime + 60_000, trashedFromPath: `${DIR}/${id}.md` }));

    const startingDoc = makeDoc(id);
    const result = await reconcileFolder(fs, state, DIR, [startingDoc], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    expect(await fs.exists(`${DIR}/.trash/${id}.md`)).toBe(true);
    expect(await fs.exists(`${DIR}/${id}.md`)).toBe(false);
  });

  it("keeps dirty docs even when the disk file vanishes", async () => {
    const dirty = makeDoc("dirty-id", { isDirty: true, content: "unsaved" });

    const result = await reconcileFolder(fs, state, DIR, [dirty], [], LOCALE);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].id).toBe("dirty-id");
  });

  it("returns changed: false when disk matches docs", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    fs.seedTextFile(`${DIR}/${id}.md`, "stable");
    await seedMeta(fs, makeMeta(id));

    const existing = makeDoc(id, { content: "stable", filePath: `${DIR}/${id}.md` });
    const result = await reconcileFolder(fs, state, DIR, [existing], [], LOCALE);

    expect(result.changed).toBe(false);
  });

  it("preserves pinned, color, and customName from existing meta when rediscovering body", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    fs.seedTextFile(`${DIR}/${id}.md`, "body");
    await seedMeta(fs, makeMeta(id, {
      fileName: "Manual Title",
      pinned: true,
      color: "blue",
      customName: true,
    }));

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs).toHaveLength(1);
    const doc = result.docs[0];
    expect(doc.fileName).toBe("Manual Title");
    expect(doc.pinned).toBe(true);
    expect(doc.color).toBe("blue");
    expect(doc.customName).toBe(true);
  });

  it("flags a non-UUID filename stem as customName when seeding meta from disk", async () => {
    fs.seedTextFile(`${DIR}/legacy-note.md`, "# Legacy\n");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].customName).toBe(true);
    const meta = await readMeta(fs, DIR, "legacy-note");
    expect(meta?.customName).toBe(true);
  });

  it("skips bodyMissing recording entirely during a bulk-guard pass", async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = `bbbbbbbb-bbbb-bbbb-bbbb-${i.toString().padStart(12, "0")}`;
      await seedMeta(fs, makeMeta(id));
      if (i >= 3) {
        fs.seedTextFile(`${DIR}/${id}.md`, `body ${i}`);
      }
    }

    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    // Bulk guard short-circuits BEFORE the recording loop, so neither
    // bodyless nor bodied ids should ever land in the observations map.
    expect(state.bodyMissing.size).toBe(0);
  });

  it("drops removed-doc ids from every group's noteIds", async () => {
    const liveId = "55555555-5555-5555-5555-555555555555";
    const goneId = "66666666-6666-6666-6666-666666666666";
    fs.seedTextFile(`${DIR}/${liveId}.md`, "live");
    await seedMeta(fs, makeMeta(liveId, { groupId: "g1" }));
    // goneId has neither a body nor a meta sidecar — it's purely a stale ref in the group.

    const docs: NoteDoc[] = [
      makeDoc(liveId, { filePath: `${DIR}/${liveId}.md` }),
      makeDoc(goneId, { filePath: `${DIR}/${goneId}.md` }),
    ];
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", collapsed: false, noteIds: [liveId, goneId], createdAt: 1000 },
    ];

    const result = await reconcileFolder(fs, state, DIR, docs, groups, LOCALE);

    expect(result.docs.find((d) => d.id === goneId)).toBeUndefined();
    expect(result.groups[0].noteIds).toEqual([liveId]);
    expect(result.groups[0].noteIds).not.toContain(goneId);
  });
});
