import { HttpError } from "../http.ts";
import {
  MAX_DOWNLOAD_BYTES,
  MAX_EXCERPT_CHARS,
  clipExcerpt,
  extractDriveText,
  googleExportMime,
  resolveExtractKind,
  type ExtractResult,
} from "./extract.ts";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
};

export type DriveClient = {
  listRecent(accessToken: string, limit: number): Promise<DriveFile[]>;
  search(accessToken: string, query: string, limit: number): Promise<DriveFile[]>;
  /** Download or export a file and extract plain text when possible. */
  readFileText(accessToken: string, file: DriveFile): Promise<ExtractResult>;
};

function asFiles(payload: unknown): DriveFile[] {
  if (!payload || typeof payload !== "object") return [];
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const out: DriveFile[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; name?: unknown; mimeType?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    out.push({
      id: row.id,
      name: row.name,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "unknown",
    });
  }
  return out;
}

function failed(status: number): HttpError {
  return new HttpError(502, "drive_unavailable", `Drive request failed (${status}).`);
}

function escapeDriveQuery(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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

export function createDriveClient(fetchImpl: typeof fetch = fetch): DriveClient {
  const downloadMedia = async (accessToken: string, fileId: string): Promise<Uint8Array> => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
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
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw failed(response.status);
    return readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
  };

  return {
    async listRecent(accessToken, limit) {
      const pageSize = Math.min(100, Math.max(1, limit));
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("pageSize", String(pageSize));
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("fields", "files(id,name,mimeType)");
      url.searchParams.set(
        "q",
        "trashed=false and mimeType != 'application/vnd.google-apps.folder'",
      );
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw failed(response.status);
      }
      return asFiles(await response.json());
    },

    async search(accessToken, query, limit) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
        .slice(0, 4);
      const nameClause =
        terms.length > 0
          ? terms.map((t) => `name contains '${escapeDriveQuery(t)}'`).join(" or ")
          : `name contains '${escapeDriveQuery(query.trim().slice(0, 40) || "notes")}'`;
      const pageSize = Math.min(100, Math.max(1, limit));
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("pageSize", String(pageSize));
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("fields", "files(id,name,mimeType)");
      url.searchParams.set(
        "q",
        `trashed=false and mimeType != 'application/vnd.google-apps.folder' and (${nameClause})`,
      );
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw failed(response.status);
      }
      return asFiles(await response.json());
    },

    async readFileText(accessToken, file) {
      const kind = resolveExtractKind(file.mimeType, file.name);
      const exportMime = googleExportMime(kind);
      try {
        if (exportMime) {
          const bytes = await exportGoogle(accessToken, file.id, exportMime);
          const text = clipExcerpt(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
          if (!text) return { ok: false, reason: "Google export returned empty text." };
          return { ok: true, text, kind };
        }
        const bytes = await downloadMedia(accessToken, file.id);
        return extractDriveText(file.mimeType, file.name, bytes);
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

/** Name-only listing (tests / fallback). */
export function summarizeDriveFiles(files: DriveFile[], heading: string): string {
  if (files.length === 0) return `${heading}\n(none)`;
  return `${heading}\n${files.map((f) => `- ${f.name} (${f.mimeType})`).join("\n")}`;
}

export type SummarizeOptions = {
  maxFiles?: number;
  maxCharsPerFile?: number;
};

/**
 * List files and attach text excerpts (PDF, Word, Google Docs, etc.).
 * Partial listing — not the user's entire Drive.
 */
export async function summarizeDriveFilesWithExcerpts(
  drive: DriveClient,
  accessToken: string,
  files: DriveFile[],
  heading: string,
  options: SummarizeOptions = {},
): Promise<string> {
  const maxFiles = Math.min(files.length, Math.max(1, options.maxFiles ?? 12));
  const maxChars = options.maxCharsPerFile ?? MAX_EXCERPT_CHARS;
  if (files.length === 0) return `${heading}\n(none)`;

  const selected = files.slice(0, maxFiles);
  const sections: string[] = [];
  for (const file of selected) {
    const result = await drive.readFileText(accessToken, file);
    if (result.ok) {
      const excerpt =
        result.text.length > maxChars
          ? `${result.text.slice(0, maxChars - 1).trimEnd()}…`
          : result.text;
      sections.push(
        `File: ${file.name} (${file.mimeType}; ${result.kind})\nContent excerpt (up to ${maxChars} characters):\n${excerpt}`,
      );
    } else {
      sections.push(
        `File: ${file.name} (${file.mimeType})\n${result.reason}`,
      );
    }
  }
  const more =
    files.length > maxFiles
      ? `\n\n(${files.length - maxFiles} more file(s) omitted from this partial listing.)`
      : "";
  return `${heading}\n\n${sections.join("\n\n")}${more}`;
}
