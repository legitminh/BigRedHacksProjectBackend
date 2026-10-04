/**
 * Extract plain text from common Drive file bytes (PDF, Office, text, etc.).
 * Google Workspace natives are exported by the Drive client before this runs.
 */

import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText as unpdfExtractText, getDocumentProxy } from "unpdf";

export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** Default clip for casual listings; intentional opens use up to MAX_FULL_FILE_CHARS. */
export const MAX_EXCERPT_CHARS = 8_000;
/** Hard cap for a single file’s extracted text when the student asks to open/check it. */
export const MAX_FULL_FILE_CHARS = 100_000;

export type ExtractOk = { ok: true; text: string; kind: string };
export type ExtractFail = { ok: false; reason: string };
export type ExtractResult = ExtractOk | ExtractFail;

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const GOOGLE_SHEETS = "application/vnd.google-apps.spreadsheet";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Map Drive mime (+ filename fallback) to an extraction kind. */
export function resolveExtractKind(mime: string, name: string): string {
  const lower = (mime || "").toLowerCase();
  const ext = extensionOf(name);

  if (lower === GOOGLE_DOC) return "google-doc";
  if (lower === GOOGLE_SLIDES) return "google-slides";
  if (lower === GOOGLE_SHEETS) return "google-sheets";
  if (lower === "application/pdf" || ext === "pdf") return "pdf";
  if (lower === DOCX || ext === "docx") return "docx";
  if (lower === PPTX || ext === "pptx") return "pptx";
  if (lower === XLSX || ext === "xlsx") return "xlsx";
  if (lower === "application/msword" || ext === "doc") return "doc-legacy";
  if (lower === "application/vnd.ms-powerpoint" || ext === "ppt") return "ppt-legacy";
  if (lower === "application/vnd.ms-excel" || ext === "xls") return "xls-legacy";
  if (lower === "application/rtf" || lower === "text/rtf" || ext === "rtf") return "rtf";
  if (lower === "text/html" || lower === "application/xhtml+xml" || ext === "html" || ext === "htm") {
    return "html";
  }
  if (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower === "application/xml" ||
    ["txt", "md", "markdown", "csv", "tsv", "json", "xml", "log", "tex", "py", "js", "ts", "java", "c", "cpp", "h", "rs", "go"].includes(ext)
  ) {
    return "text";
  }
  if (lower === "application/octet-stream" || !lower || lower === "unknown") {
    if (ext === "pdf") return "pdf";
    if (ext === "docx") return "docx";
    if (ext === "pptx") return "pptx";
    if (ext === "xlsx") return "xlsx";
    if (["txt", "md", "csv", "json"].includes(ext)) return "text";
  }
  return "unsupported";
}

/** Short, human/LLM-friendly type label for inventory lines (`pdf`, `docx`, `sheet`, …). */
export function shortTypeLabel(mime: string, name: string): string {
  const lower = (mime || "").toLowerCase();
  if (lower === "application/vnd.google-apps.folder") return "folder";
  if (lower === "application/vnd.google-apps.shortcut") return "shortcut";
  if (lower === "application/vnd.google-apps.form") return "gform";
  if (lower === "application/vnd.google-apps.drawing") return "gdrawing";
  const kind = resolveExtractKind(mime, name);
  switch (kind) {
    case "google-doc":
      return "gdoc";
    case "google-slides":
      return "gslides";
    case "google-sheets":
      return "gsheet";
    case "doc-legacy":
      return "doc";
    case "ppt-legacy":
      return "ppt";
    case "xls-legacy":
      return "xls";
    case "unsupported":
      break;
    default:
      return kind;
  }
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  const ext = extensionOf(name);
  if (ext) return ext.slice(0, 8);
  const tail = lower.split("/").pop() ?? "";
  return tail ? tail.slice(0, 12) : "file";
}

export function googleExportMime(kind: string): string | null {
  switch (kind) {
    case "google-doc":
    case "google-slides":
      return "text/plain";
    case "google-sheets":
      return "text/csv";
    default:
      return null;
  }
}

export function clipExcerpt(text: string, maxChars = MAX_EXCERPT_CHARS): string {
  const cleaned = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

export async function extractDriveText(
  mime: string,
  name: string,
  bytes: Uint8Array,
  maxChars: number = MAX_FULL_FILE_CHARS,
): Promise<ExtractResult> {
  if (bytes.length === 0) return { ok: false, reason: "File was empty." };
  const kind = resolveExtractKind(mime, name);
  const clip = (text: string) => clipExcerpt(text, maxChars);
  try {
    switch (kind) {
      case "google-doc":
      case "google-slides":
      case "google-sheets":
      case "text":
        return { ok: true, text: clip(decodeUtf8(bytes)), kind };
      case "pdf":
        return { ok: true, text: clip(await extractPdf(bytes)), kind };
      case "docx":
        return { ok: true, text: clip(await extractDocx(bytes)), kind };
      case "pptx":
        return { ok: true, text: clip(await extractPptx(bytes)), kind };
      case "xlsx":
        return { ok: true, text: clip(await extractXlsx(bytes)), kind };
      case "html":
        return { ok: true, text: clip(stripTags(decodeUtf8(bytes))), kind };
      case "rtf":
        return { ok: true, text: clip(stripRtf(decodeUtf8(bytes))), kind };
      case "doc-legacy":
        return {
          ok: false,
          reason: "Legacy .doc Word format isn’t supported — re-save as .docx or PDF.",
        };
      case "ppt-legacy":
        return {
          ok: false,
          reason: "Legacy .ppt isn’t supported — re-save as .pptx or PDF.",
        };
      case "xls-legacy":
        return {
          ok: false,
          reason: "Legacy .xls isn’t supported — re-save as .xlsx or CSV.",
        };
      default:
        return {
          ok: false,
          reason: `No text extractor for this type (${mime || "unknown"}).`,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "extract failed";
    return { ok: false, reason: `Could not extract text: ${message}` };
  }
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const result = await unpdfExtractText(pdf, { mergePages: true });
  const text = typeof result.text === "string" ? result.text : (result.text ?? []).join("\n");
  if (!text.trim()) throw new Error("PDF had no extractable text (may be scanned images only)");
  return text;
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (!result.value.trim()) throw new Error("Word document had no extractable text");
  return result.value;
}

async function extractPptx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (paths.length === 0) throw new Error("PowerPoint had no slides");
  const parts: string[] = [];
  for (const path of paths) {
    const xml = await zip.file(path)!.async("string");
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? ""));
    const line = texts.join(" ").replace(/\s+/g, " ").trim();
    if (line) parts.push(line);
  }
  if (parts.length === 0) throw new Error("PowerPoint had no extractable text");
  return parts.join("\n");
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const shared = zip.file("xl/sharedStrings.xml");
  if (shared) {
    const xml = await shared.async("string");
    const strings = [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1] ?? ""));
    const joined = strings.filter(Boolean).join(" | ");
    if (joined.trim()) return joined;
  }
  // Fallback: concatenate cell values from the first few sheets.
  const sheets = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
    .sort()
    .slice(0, 3);
  const parts: string[] = [];
  for (const path of sheets) {
    const xml = await zip.file(path)!.async("string");
    const vals = [...xml.matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1] ?? "");
    if (vals.length) parts.push(vals.join(" | "));
  }
  if (parts.length === 0) throw new Error("Spreadsheet had no extractable text");
  return parts.join("\n");
}

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\{\\*\\[^{}]+\}/g, " ")
    .replace(/\\[a-z]+\d* ?/gi, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
