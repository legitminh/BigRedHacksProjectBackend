import type { ToolConnection } from "../store/types.ts";

export type ToolCatalogEntry = {
  id: string;
  provider: string;
  title: string;
  summary: string;
  scopes: readonly string[];
  scopeLabels: readonly string[];
};

/** Code catalog. A new tool is an entry here plus a provider connector, not a schema change. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: "google_calendar",
    provider: "google",
    title: "Google Calendar",
    summary: "Create and edit events on the calendar account you connect.",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    scopeLabels: ["Create and edit calendar events"],
  },
  {
    id: "google_drive",
    provider: "google",
    title: "Google Drive",
    summary: "Read files in the Drive account you connect.",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    scopeLabels: ["View files you can access"],
  },
];

/** Tools copied once from a legacy bundled Calendar/Drive grant. Not every future catalog entry. */
const LEGACY_TOOL_IDS = ["google_calendar", "google_drive"] as const;

export function toolById(id: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG.find((tool) => tool.id === id);
}

export function legacyGoogleToolConnections(
  userId: string,
  refreshToken: string,
  nowIso: string,
): ToolConnection[] {
  return LEGACY_TOOL_IDS.map((id) => {
    const tool = toolById(id);
    if (!tool) throw new Error(`Missing catalog tool ${id}`);
    return {
      userId,
      toolId: tool.id,
      provider: tool.provider,
      scopes: tool.scopes.join(" "),
      refreshToken,
      status: "connected",
      connectedAt: nowIso,
      updatedAt: nowIso,
    };
  });
}
