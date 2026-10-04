import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DRIVE_CACHE_MAX_ROWS_PER_USER,
  driveCacheEvictFileIds,
  readFileTextCached,
  type DriveCachedFile,
} from "../src/drive/cache.ts";
import type { DriveClient, DriveFile } from "../src/drive/client.ts";
import type { ExtractResult } from "../src/drive/extract.ts";
import { openFileStore } from "../src/store/file.ts";

const USER = "11111111-1111-4111-8111-111111111111";

function sampleFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "file-a",
    name: "notes.txt",
    mimeType: "text/plain",
    modifiedTime: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

function mockDrive(results: Record<string, ExtractResult>): {
  drive: DriveClient;
  readCalls: () => number;
} {
  let calls = 0;
  const drive: DriveClient = {
    listRecent: async () => [],
    search: async () => [],
    listFolder: async () => [],
    findFolders: async () => [],
    inventory: async () => ({
      files: [],
      nextPageToken: null,
      truncated: false,
      folderCount: 0,
    }),
    async readFileText(_token, file) {
      calls += 1;
      return results[file.id] ?? { ok: false, reason: "missing mock" };
    },
  };
  return { drive, readCalls: () => calls };
}

async function withStore(
  fn: (ctx: { store: ReturnType<typeof openFileStore>; dir: string }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-drive-cache-"));
  const store = openFileStore(join(dir, "store.json"));
  try {
    await fn({ store, dir });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("readFileTextCached returns cached text on modifiedTime hit", async () => {
  await withStore(async ({ store }) => {
    const file = sampleFile();
    const { drive, readCalls } = mockDrive({
      "file-a": { ok: true, text: "from network", kind: "text" },
    });

    await store.upsertDriveFileCache({
      userId: USER,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime!,
      text: "from cache",
      extractedAt: "2026-04-01T10:00:00.000Z",
      kind: "text",
    });

    const result = await readFileTextCached(drive, store, USER, "token", file);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, "from cache");
    assert.equal(readCalls(), 0);
  });
});

test("readFileTextCached misses when no row exists", async () => {
  await withStore(async ({ store }) => {
    const file = sampleFile();
    const { drive, readCalls } = mockDrive({
      "file-a": { ok: true, text: "fresh", kind: "text" },
    });

    const result = await readFileTextCached(drive, store, USER, "token", file);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, "fresh");
    assert.equal(readCalls(), 1);

    const cached = await store.getDriveFileCache(USER, file.id);
    assert.ok(cached);
    assert.equal(cached!.text, "fresh");
    assert.equal(cached!.modifiedTime, file.modifiedTime);
  });
});

test("readFileTextCached refetches when modifiedTime is stale", async () => {
  await withStore(async ({ store }) => {
    const file = sampleFile({ modifiedTime: "2026-04-02T12:00:00.000Z" });
    await store.upsertDriveFileCache({
      userId: USER,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: "2026-04-01T12:00:00.000Z",
      text: "old body",
      extractedAt: "2026-04-01T10:00:00.000Z",
      kind: "text",
    });

    const { drive, readCalls } = mockDrive({
      "file-a": { ok: true, text: "new body", kind: "text" },
    });

    const result = await readFileTextCached(drive, store, USER, "token", file);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.text, "new body");
    assert.equal(readCalls(), 1);

    const cached = await store.getDriveFileCache(USER, file.id);
    assert.equal(cached?.modifiedTime, file.modifiedTime);
    assert.equal(cached?.text, "new body");
  });
});

test("upsertDriveFileCache evicts oldest extracted_at beyond row cap", async () => {
  await withStore(async ({ store }) => {
    const rows: DriveCachedFile[] = [];
    for (let i = 0; i < DRIVE_CACHE_MAX_ROWS_PER_USER; i += 1) {
      rows.push({
        userId: USER,
        fileId: `f-${i}`,
        name: `file-${i}`,
        mimeType: "text/plain",
        modifiedTime: "2026-01-01T00:00:00.000Z",
        text: `body-${i}`,
        extractedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    for (const row of rows) {
      await store.upsertDriveFileCache(row);
    }

    await store.upsertDriveFileCache({
      userId: USER,
      fileId: "f-new",
      name: "newest",
      mimeType: "text/plain",
      modifiedTime: "2026-02-01T00:00:00.000Z",
      text: "new",
      extractedAt: new Date(Date.UTC(2026, 1, 1)).toISOString(),
    });

    const listed = await store.listDriveFileCache(USER);
    assert.equal(listed.length, DRIVE_CACHE_MAX_ROWS_PER_USER);
    assert.ok(!listed.some((row) => row.fileId === "f-0"));
    assert.ok(listed.some((row) => row.fileId === "f-new"));
  });
});

test("driveCacheEvictFileIds skips eviction when under cap", () => {
  const rows: DriveCachedFile[] = [
    {
      userId: USER,
      fileId: "a",
      name: "a",
      mimeType: "text/plain",
      modifiedTime: "",
      text: "x",
      extractedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  assert.deepEqual(driveCacheEvictFileIds(rows, "b"), []);
});
