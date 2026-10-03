export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
};

export type DriveClient = {
  listRecent(accessToken: string, limit: number): Promise<DriveFile[]>;
  search(accessToken: string, query: string, limit: number): Promise<DriveFile[]>;
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

function escapeDriveQuery(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createDriveClient(fetchImpl: typeof fetch = fetch): DriveClient {
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
        throw new Error(`Drive list failed: HTTP ${response.status}`);
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
        throw new Error(`Drive search failed: HTTP ${response.status}`);
      }
      return asFiles(await response.json());
    },
  };
}

export function summarizeDriveFiles(files: DriveFile[], heading: string): string {
  if (files.length === 0) return `${heading}\n(none)`;
  return `${heading}\n${files.map((f) => `- ${f.name} (${f.mimeType})`).join("\n")}`;
}
