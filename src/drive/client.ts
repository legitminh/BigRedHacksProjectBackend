import { HttpError } from "../http.ts";
import {
  MAX_DOWNLOAD_BYTES,
  MAX_EXCERPT_CHARS,
  MAX_FULL_FILE_CHARS,
  clipExcerpt,
  extractDriveText,
  googleExportMime,
  resolveExtractKind,
  shortTypeLabel,
  type ExtractResult,
} from "./extract.ts";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  parents?: string[];
  /** Parent folder name, when the caller resolved a folder index. */
  folderName?: string;
  /** Slash-joined folder path ("Classes/Fall/…"), when a folder index was available. */
  folderPath?: string;
};

export type InventoryPage = {
  files: DriveFile[];
  nextPageToken: string | null;
  /** True when `maxFiles`/`maxPages` stopped the crawl before Drive ran out of files. */
  truncated: boolean;
  /** Number of folders in the resolved folder index (0 when paths were skipped). */
  folderCount: number;
};

export type InventoryOptions = {
  maxFiles?: number;
  maxPages?: number;
  pageToken?: string | null;
  /** Resolve `folderPath` by indexing the user's folders first. Costs a few extra calls. */
  includeFolderPaths?: boolean;
  /** Extra Drive `q` clause ANDed with `trashed=false` (already-escaped by the caller). */
  extraQuery?: string | null;
};

export type DriveClient = {
  /** Most recently viewed (or modified) files. No name or folder assumptions. */
  listRecent(accessToken: string, limit: number): Promise<DriveFile[]>;
  /** Name + fullText search across everything the token can see. */
  search(accessToken: string, query: string, limit: number): Promise<DriveFile[]>;
  /** Direct children of a folder id (generic browse; folders included). */
  listFolder(accessToken: string, folderId: string, limit: number): Promise<DriveFile[]>;
  /** Folders matching a name fragment — lets the model find whatever the student actually named things. */
  findFolders(accessToken: string, query: string, limit: number): Promise<DriveFile[]>;
  /** Page through metadata for every non-trashed file the token can see. */
  inventory(accessToken: string, options?: InventoryOptions): Promise<InventoryPage>;
  /** Download or export a file and extract plain text when possible. */
  readFileText(
    accessToken: string,
    file: DriveFile,
    options?: { maxChars?: number },
  ): Promise<ExtractResult>;
};

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,viewedByMeTime,parents";
const LIST_PAGE_MAX = 1000;
const FOLDER_INDEX_MAX = 3_000;

export const INVENTORY_DEFAULT_MAX_FILES = 1_500;
export const INVENTORY_HARD_MAX_FILES = 10_000;

type RawRow = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  viewedByMeTime?: unknown;
  parents?: unknown;
};

function asFiles(payload: unknown, folderName?: string): DriveFile[] {
  if (!payload || typeof payload !== "object") return [];
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const out: DriveFile[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const row = item as RawRow;
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    const parents = Array.isArray(row.parents)
      ? row.parents.filter((p): p is string => typeof p === "string")
      : undefined;
    out.push({
      id: row.id,
      name: row.name,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "unknown",
      ...(typeof row.modifiedTime === "string" ? { modifiedTime: row.modifiedTime } : {}),
      ...(typeof row.viewedByMeTime === "string" ? { viewedByMeTime: row.viewedByMeTime } : {}),
      ...(parents && parents.length ? { parents } : {}),
      ...(folderName ? { folderName } : {}),
    });
  }
  return out;
}

function nextToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const token = (payload as { nextPageToken?: unknown }).nextPageToken;
  return typeof token === "string" && token ? token : null;
}

function failed(status: number): HttpError {
  return new HttpError(502, "drive_unavailable", `Drive request failed (${status}).`);
}

export function escapeDriveQuery(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** Split a free-form question into Drive-searchable terms. Purely lexical — no domain words. */
export function searchTerms(query: string, max = 4): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "what", "when", "where", "which", "about",
    "from", "have", "has", "had", "are", "was", "were", "you", "your", "can", "could", "would",
    "should", "please", "tell", "show", "give", "find", "need", "want", "any", "all", "get",
    "into", "out", "how", "why", "who", "does", "did", "will", "there", "their", "they",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/i)) {
    const term = raw.trim();
    if (term.length < 3 || stop.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

function dedupeFiles(files: DriveFile[]): DriveFile[] {
  const seen = new Set<string>();
  const out: DriveFile[] = [];
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    out.push(file);
  }
  return out;
}

function recencyOf(file: DriveFile): number {
  const viewed = file.viewedByMeTime ? Date.parse(file.viewedByMeTime) : NaN;
  const modified = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  const best = Math.max(Number.isFinite(viewed) ? viewed : 0, Number.isFinite(modified) ? modified : 0);
  return best;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = maxBytes - total;
    if (value.length <= room) {
      chunks.push(value);
      total += value.length;
    } else {
      chunks.push(value.subarray(0, room));
      total += room;
      break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

type ListParams = {
  accessToken: string;
  q: string;
  pageSize: number;
  orderBy?: string;
  pageToken?: string | null;
  folderName?: string;
};

type ListResult = { files: DriveFile[]; nextPageToken: string | null };

export function createDriveClient(fetchImpl: typeof fetch = fetch): DriveClient {
  const listPage = async (params: ListParams): Promise<ListResult> => {
    const run = async (withCorpora: boolean) => {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("pageSize", String(Math.min(LIST_PAGE_MAX, Math.max(1, params.pageSize))));
      url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
      url.searchParams.set("q", params.q);
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      if (withCorpora) url.searchParams.set("corpora", "allDrives");
      if (params.orderBy) url.searchParams.set("orderBy", params.orderBy);
      if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
      return fetchImpl(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
    };
    let response = await run(true);
    if (!response.ok && (response.status === 400 || response.status === 403)) {
      response = await run(false);
    }
    if (!response.ok) throw failed(response.status);
    const payload = await response.json();
    return { files: asFiles(payload, params.folderName), nextPageToken: nextToken(payload) };
  };

  const listFiles = async (params: ListParams): Promise<DriveFile[]> =>
    (await listPage(params)).files;

  /** id → {name, parents} for every folder we can see, so inventory lines carry a real path. */
  const folderIndex = async (accessToken: string): Promise<Map<string, DriveFile>> => {
    const index = new Map<string, DriveFile>();
    let token: string | null = null;
    for (let page = 0; page < 4 && index.size < FOLDER_INDEX_MAX; page += 1) {
      const result: ListResult = await listPage({
        accessToken,
        pageSize: LIST_PAGE_MAX,
        pageToken: token,
        q: `trashed=false and mimeType='${FOLDER_MIME}'`,
      });
      for (const folder of result.files) index.set(folder.id, folder);
      token = result.nextPageToken;
      if (!token) break;
    }
    return index;
  };

  const downloadMedia = async (accessToken: string, fileId: string): Promise<Uint8Array> => {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw failed(response.status);
    return readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
  };

  const exportGoogle = async (
    accessToken: string,
    fileId: string,
    exportMime: string,
  ): Promise<Uint8Array> => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`,
    );
    url.searchParams.set("mimeType", exportMime);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw failed(response.status);
    return readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
  };

  return {
    async listRecent(accessToken, limit) {
      const pageSize = Math.min(LIST_PAGE_MAX, Math.max(1, limit));
      // Drive UI "Recent" tracks views; fall back to modifiedTime when the token
      // can't order by viewedByMeTime (shared drives sometimes reject it).
      try {
        return await listFiles({
          accessToken,
          pageSize,
          orderBy: "viewedByMeTime desc",
          q: `trashed=false and mimeType != '${FOLDER_MIME}'`,
        });
      } catch {
        return listFiles({
          accessToken,
          pageSize,
          orderBy: "modifiedTime desc",
          q: `trashed=false and mimeType != '${FOLDER_MIME}'`,
        });
      }
    },

    async search(accessToken, query, limit) {
      const terms = searchTerms(query);
      const effective = terms.length > 0 ? terms : [query.trim().slice(0, 40)].filter(Boolean);
      if (effective.length === 0) return [];
      // Name + fullText so a PDF matches whether the student put the keyword in
      // the filename or only inside the document.
      const clause = effective
        .flatMap((term) => {
          const escaped = escapeDriveQuery(term);
          return [`name contains '${escaped}'`, `fullText contains '${escaped}'`];
        })
        .join(" or ");
      const pageSize = Math.min(LIST_PAGE_MAX, Math.max(1, limit));
      const q = `trashed=false and mimeType != '${FOLDER_MIME}' and (${clause})`;
      let hits: DriveFile[];
      try {
        hits = await listFiles({ accessToken, pageSize, orderBy: "viewedByMeTime desc", q });
      } catch {
        hits = await listFiles({ accessToken, pageSize, orderBy: "modifiedTime desc", q });
      }
      return hits.slice(0, pageSize);
    },

    async listFolder(accessToken, folderId, limit) {
      return listFiles({
        accessToken,
        pageSize: Math.min(LIST_PAGE_MAX, Math.max(1, limit)),
        orderBy: "folder,name",
        q: `'${escapeDriveQuery(folderId)}' in parents and trashed=false`,
      });
    },

    async findFolders(accessToken, query, limit) {
      const terms = searchTerms(query, 3);
      const effective = terms.length > 0 ? terms : [query.trim().slice(0, 40)].filter(Boolean);
      if (effective.length === 0) return [];
      const clause = effective
        .map((term) => `name contains '${escapeDriveQuery(term)}'`)
        .join(" or ");
      return listFiles({
        accessToken,
        pageSize: Math.min(100, Math.max(1, limit)),
        q: `trashed=false and mimeType='${FOLDER_MIME}' and (${clause})`,
      });
    },

    async inventory(accessToken, options = {}) {
      const maxFiles = Math.min(
        INVENTORY_HARD_MAX_FILES,
        Math.max(1, options.maxFiles ?? INVENTORY_DEFAULT_MAX_FILES),
      );
      const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 12));
      const extra = options.extraQuery?.trim();
      const q = [`trashed=false`, `mimeType != '${FOLDER_MIME}'`, ...(extra ? [`(${extra})`] : [])].join(
        " and ",
      );

      const folders =
        options.includeFolderPaths === false
          ? new Map<string, DriveFile>()
          : await folderIndex(accessToken).catch(() => new Map<string, DriveFile>());

      const collected: DriveFile[] = [];
      let token: string | null = options.pageToken ?? null;
      let pages = 0;
      let truncated = false;
      while (pages < maxPages) {
        const result: ListResult = await listPage({
          accessToken,
          pageSize: Math.min(LIST_PAGE_MAX, maxFiles - collected.length),
          pageToken: token,
          q,
        });
        pages += 1;
        for (const file of result.files) {
          if (folders.size > 0) {
            const path = folderPathOf(file, folders);
            if (path) file.folderPath = path;
            const parentId = file.parents?.[0];
            const parent = parentId ? folders.get(parentId) : undefined;
            if (parent) file.folderName = parent.name;
          }
          collected.push(file);
        }
        token = result.nextPageToken;
        if (!token) break;
        if (collected.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
      if (token && pages >= maxPages) truncated = true;
      return {
        files: dedupeFiles(collected),
        nextPageToken: token,
        truncated,
        folderCount: folders.size,
      };
    },

    async readFileText(accessToken, file, options = {}) {
      const maxChars = Math.min(
        MAX_FULL_FILE_CHARS,
        Math.max(500, options.maxChars ?? MAX_FULL_FILE_CHARS),
      );
      const kind = resolveExtractKind(file.mimeType, file.name);
      const exportMime = googleExportMime(kind);
      try {
        if (exportMime) {
          const bytes = await exportGoogle(accessToken, file.id, exportMime);
          const text = clipExcerpt(
            new TextDecoder("utf-8", { fatal: false }).decode(bytes),
            maxChars,
          );
          if (!text) return { ok: false, reason: "Google export returned empty text." };
          return { ok: true, text, kind };
        }
        const bytes = await downloadMedia(accessToken, file.id);
        return extractDriveText(file.mimeType, file.name, bytes, maxChars);
      } catch (error) {
        if (error instanceof HttpError) {
          return { ok: false, reason: error.message };
        }
        const message = error instanceof Error ? error.message : "download failed";
        return { ok: false, reason: message };
      }
    },
  };
}

/** Walk `parents` up the folder index. Returns "" for files at the Drive root. */
export function folderPathOf(file: DriveFile, folders: Map<string, DriveFile>): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current = file.parents?.[0];
  while (current && !seen.has(current) && segments.length < 8) {
    seen.add(current);
    const folder = folders.get(current);
    if (!folder) break;
    segments.unshift(folder.name);
    current = folder.parents?.[0];
  }
  return segments.join("/");
}

/** Name-only listing (tests / fallback). */
export function summarizeDriveFiles(files: DriveFile[], heading: string): string {
  if (files.length === 0) return `${heading}\n(none)`;
  return `${heading}\n${files
    .map((f) => {
      const where = f.folderPath || f.folderName;
      return `- ${f.name} (${f.mimeType}${where ? ` in “${where}”` : ""})`;
    })
    .join("\n")}`;
}

export type InventoryFormatOptions = {
  heading?: string;
  /** Hard character budget for the rendered block (token hygiene). */
  maxChars?: number;
  totalKnown?: number;
  truncated?: boolean;
};

export const INVENTORY_DEFAULT_MAX_CHARS = 12_000;

/**
 * Compact, grouped metadata listing: one line per folder, `name (type)` per file.
 * Names and types only — excerpts come from targeted search, never from here.
 */
export function formatDriveInventory(
  files: DriveFile[],
  options: InventoryFormatOptions = {},
): string {
  const heading =
    options.heading ??
    "DRIVE INVENTORY (file names/types/folders only — no contents; use Drive search for contents):";
  if (files.length === 0) {
    return `${heading}\n(no files visible to Waypoint)`;
  }
  const maxChars = Math.max(120, options.maxChars ?? INVENTORY_DEFAULT_MAX_CHARS);

  // Most-recent-first so the budget keeps what the student actually touches.
  const ordered = [...files].sort((a, b) => recencyOf(b) - recencyOf(a));

  const groups = new Map<string, string[]>();
  const order: string[] = [];
  let listed = 0;
  let used = heading.length;
  for (const file of ordered) {
    const path = file.folderPath || file.folderName || "(My Drive root)";
    const entry = `${file.name} (${shortTypeLabel(file.mimeType, file.name)})`;
    const cost = entry.length + 2 + (groups.has(path) ? 0 : path.length + 4);
    if (used + cost > maxChars) break;
    used += cost;
    if (!groups.has(path)) {
      groups.set(path, []);
      order.push(path);
    }
    groups.get(path)!.push(entry);
    listed += 1;
  }

  const total = options.totalKnown ?? files.length;
  const scope =
    listed >= total && !options.truncated
      ? `all ${total} file(s) Waypoint can see`
      : `${listed} of ${total}${options.truncated ? "+" : ""} file(s) Waypoint can see, most recent first`;
  const body = order
    .sort((a, b) => a.localeCompare(b))
    .map((path) => `${path}/ — ${groups.get(path)!.join(", ")}`)
    .join("\n");
  const omitted = total - listed;
  const footer =
    omitted > 0 || options.truncated
      ? `\n(${omitted > 0 ? `${omitted} more file(s) not listed here` : "listing truncated"}; ask Waypoint to search Drive by keyword to reach them.)`
      : "";
  return `${heading} ${scope}\n${body}${footer}`;
}

export type SummarizeOptions = {
  /** How many of the passed files get a text excerpt. The rest are listed by name only. */
  maxExcerptFiles?: number;
  maxCharsPerFile?: number;
  /** Character budget for the name-only inventory block that precedes the excerpts. */
  maxInventoryChars?: number;
  /** Label for the content block (“FULL CONTENTS” vs “Content excerpt”). */
  contentLabel?: string;
};

/**
 * Inventory first (every file by name/type/folder), then text contents for the
 * top files. Intentional opens use a large per-file budget.
 */
export async function summarizeDriveFilesWithExcerpts(
  drive: DriveClient,
  accessToken: string,
  files: DriveFile[],
  heading: string,
  options: SummarizeOptions = {},
): Promise<string> {
  if (files.length === 0) return `${heading}\n(none)`;
  const excerptCount = Math.min(files.length, Math.max(0, options.maxExcerptFiles ?? 5));
  const maxChars = Math.min(
    MAX_FULL_FILE_CHARS,
    Math.max(500, options.maxCharsPerFile ?? MAX_EXCERPT_CHARS),
  );
  const contentLabel = options.contentLabel ?? "Content excerpt";

  const inventory = formatDriveInventory(files, {
    heading: "FILE INVENTORY (names, types, and folders only — no contents):",
    maxChars: options.maxInventoryChars ?? 4_000,
  });
  if (excerptCount === 0) return `${heading}\n${inventory}`;

  const sections: string[] = [];
  let loaded = 0;
  for (const file of files.slice(0, excerptCount)) {
    const where = file.folderPath || file.folderName;
    const label = where ? ` [folder: ${where}]` : "";
    const result = await drive.readFileText(accessToken, file, { maxChars });
    if (result.ok) {
      loaded += 1;
      const excerpt =
        result.text.length > maxChars
          ? `${result.text.slice(0, maxChars - 1).trimEnd()}…`
          : result.text;
      sections.push(
        `File: ${file.name}${label} (${file.mimeType}; ${result.kind})\n${contentLabel} (${excerpt.length} characters):\n${excerpt}`,
      );
    } else {
      sections.push(
        `File: ${file.name}${label} (${file.mimeType})\nFAILED TO LOAD CONTENTS: ${result.reason}`,
      );
    }
  }
  const more =
    files.length > excerptCount
      ? `\n\n(Contents shown for the top ${excerptCount} only; the rest appear in the inventory above by name.)`
      : "";
  const status =
    loaded === 0
      ? `TEXT LOAD FAILED (0 of ${sections.length} files yielded readable text — do not invent due dates):`
      : `${contentLabel.toUpperCase()} (loaded ${loaded} of ${sections.length} file(s)):`;
  return [heading, inventory, "", status, "", `${sections.join("\n\n")}${more}`].join("\n");
}
