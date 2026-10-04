import type { DriveClient, DriveFile } from "./client.ts";
import { clipExcerpt, type ExtractResult, resolveExtractKind } from "./extract.ts";
import type { Store } from "../store/types.ts";

/** Max extracted text persisted per Drive file row. */
export const DRIVE_CACHE_MAX_TEXT_CHARS = 100_000;
/** Max cached files per user; oldest `extractedAt` rows are evicted on upsert. */
export const DRIVE_CACHE_MAX_ROWS_PER_USER = 200;

export type DriveCachedFile = {
  userId: string;
  fileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  text: string;
  extractedAt: string;
  kind?: string;
};

export interface DriveFileCache {
  get(userId: string, fileId: string): Promise<DriveCachedFile | null>;
  put(entry: DriveCachedFile): Promise<void>;
  getMany(userId: string, fileIds: string[]): Promise<DriveCachedFile[]>;
  deleteForUser(userId: string): Promise<void>;
}

export function clipCachedText(text: string): string {
  if (text.length <= DRIVE_CACHE_MAX_TEXT_CHARS) return text;
  return text.slice(0, DRIVE_CACHE_MAX_TEXT_CHARS);
}

/** File ids to remove so the user stays at or under the row cap after an upsert. */
export function driveCacheEvictFileIds(
  forUser: DriveCachedFile[],
  upsertingFileId: string,
): string[] {
  const isUpdate = forUser.some((row) => row.fileId === upsertingFileId);
  const nextCount = isUpdate ? forUser.length : forUser.length + 1;
  if (nextCount <= DRIVE_CACHE_MAX_ROWS_PER_USER) return [];
  const toRemove = nextCount - DRIVE_CACHE_MAX_ROWS_PER_USER;
  return [...forUser]
    .filter((row) => row.fileId !== upsertingFileId)
    .sort((a, b) => Date.parse(a.extractedAt) - Date.parse(b.extractedAt))
    .slice(0, toRemove)
    .map((row) => row.fileId);
}

export function driveFileCacheFromStore(store: Store): DriveFileCache {
  return {
    get: (userId, fileId) => store.getDriveFileCache(userId, fileId),
    put: (entry) => store.upsertDriveFileCache(entry),
    async getMany(userId, fileIds) {
      if (fileIds.length === 0) return [];
      const want = new Set(fileIds);
      const rows = await store.listDriveFileCache(userId);
      return rows.filter((row) => want.has(row.fileId));
    },
    deleteForUser: (userId) => store.clearDriveFileCache(userId),
  };
}

/**
 * Cache-first Drive text read: reuse stored text when `modifiedTime` matches;
 * otherwise download/extract, persist, and return.
 */
export async function readFileTextCached(
  drive: DriveClient,
  store: Store,
  userId: string,
  accessToken: string,
  file: DriveFile,
  maxChars?: number,
): Promise<ExtractResult> {
  const modifiedTime = file.modifiedTime ?? "";
  const cached = await store.getDriveFileCache(userId, file.id);
  if (cached && cached.modifiedTime === modifiedTime) {
    const text = maxChars != null ? clipExcerpt(cached.text, maxChars) : cached.text;
    return {
      ok: true,
      text,
      kind: cached.kind ?? resolveExtractKind(file.mimeType, file.name),
    };
  }

  const result = await drive.readFileText(accessToken, file, { maxChars });
  if (result.ok) {
    await store.upsertDriveFileCache({
      userId,
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime,
      text: result.text,
      extractedAt: new Date().toISOString(),
      kind: result.kind,
    });
  }
  return result;
}
