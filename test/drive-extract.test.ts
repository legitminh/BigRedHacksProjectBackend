import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import JSZip from "jszip";

import {
  createDriveClient,
  formatDriveInventory,
  summarizeDriveFilesWithExcerpts,
  type DriveFile,
} from "../src/drive/client.ts";
import {
  extractDriveText,
  resolveExtractKind,
  clipExcerpt,
} from "../src/drive/extract.ts";

function writeTinyPdf(path: string, phrase: string) {
  execFileSync("python3", [
    "-c",
    `
from pathlib import Path
phrase = ${JSON.stringify(phrase)}
content = f"BT /F1 24 Tf 100 700 Td ({phrase}) Tj ET".encode()
pdf = bytearray(b"%PDF-1.4\\n")
offs = []
def obj(data: bytes):
    offs.append(len(pdf)); pdf.extend(data)
obj(b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\\n")
obj(b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\\n")
obj(b"3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\\n")
obj(f"4 0 obj<< /Length {len(content)} >>stream\\n".encode() + content + b"\\nendstream\\nendobj\\n")
obj(b"5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\\n")
xref = len(pdf)
pdf.extend(b"xref\\n0 6\\n0000000000 65535 f \\n")
for o in offs:
    pdf.extend(f"{o:010d} 00000 n \\n".encode())
pdf.extend(f"trailer<< /Size 6 /Root 1 0 R >>\\nstartxref\\n{xref}\\n%%EOF\\n".encode())
Path(${JSON.stringify(path)}).write_bytes(pdf)
`,
  ]);
}

test("resolveExtractKind covers common syllabus file types", () => {
  assert.equal(resolveExtractKind("application/pdf", "CHEM2071.pdf"), "pdf");
  assert.equal(resolveExtractKind("application/octet-stream", "BIOMG.pdf"), "pdf");
  assert.equal(
    resolveExtractKind(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x.docx",
    ),
    "docx",
  );
  assert.equal(resolveExtractKind("application/msword", "old.doc"), "doc-legacy");
  assert.equal(
    resolveExtractKind("application/vnd.google-apps.document", "syllabus"),
    "google-doc",
  );
  assert.equal(resolveExtractKind("text/plain", "notes.txt"), "text");
});

test("extracts PDF text", async () => {
  const path = join(tmpdir(), `waypoint-drive-${Date.now()}.pdf`);
  writeTinyPdf(path, "CHEM 2071 Student Expectations");
  const bytes = new Uint8Array(readFileSync(path));
  const result = await extractDriveText("application/pdf", "CHEM2071.pdf", bytes);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /CHEM 2071 Student Expectations/);
});

test("extracts DOCX and PPTX text", async () => {
  const docxZip = new JSZip();
  docxZip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>BIOMG 1350 Syllabus</w:t></w:r></w:p></w:body></w:document>`,
  );
  const docx = await docxZip.generateAsync({ type: "uint8array" });
  const docxResult = await extractDriveText(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "biomg.docx",
    docx,
  );
  assert.equal(docxResult.ok, true);
  if (docxResult.ok) assert.match(docxResult.text, /BIOMG 1350/);

  const pptZip = new JSZip();
  pptZip.file(
    "ppt/slides/slide1.xml",
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Lecture 1</a:t></p:sld>`,
  );
  const pptx = await pptZip.generateAsync({ type: "uint8array" });
  const pptxResult = await extractDriveText(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "slides.pptx",
    pptx,
  );
  assert.equal(pptxResult.ok, true);
  if (pptxResult.ok) assert.match(pptxResult.text, /Lecture 1/);
});

test("extracts HTML and rejects legacy .doc", async () => {
  const html = await extractDriveText(
    "text/html",
    "a.html",
    new TextEncoder().encode("<h1>Deadlines</h1><p>Quiz Friday</p>"),
  );
  assert.equal(html.ok, true);
  if (html.ok) assert.match(html.text, /Quiz Friday/);

  const legacy = await extractDriveText("application/msword", "old.doc", new Uint8Array([1, 2, 3]));
  assert.equal(legacy.ok, false);
});

test("clipExcerpt bounds length", () => {
  assert.equal(clipExcerpt("short"), "short");
  assert.ok(clipExcerpt("x".repeat(100), 20).endsWith("…"));
});

test("listRecent asks Drive for recent files without assuming any folder names", async () => {
  const queries: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q") ?? "");
    return Response.json({
      files: [
        { id: "doc1", name: "plan", mimeType: "application/vnd.google-apps.document" },
        { id: "pdf1", name: "week3.pdf", mimeType: "application/pdf" },
      ],
    });
  }) as typeof fetch;

  const files = await createDriveClient(fetchImpl).listRecent("tok", 6);
  assert.equal(files.length, 2);
  // The only constraints may be "not trashed" and "not a folder" — nothing name-based.
  for (const q of queries) {
    assert.ok(!/name contains/i.test(q), `unexpected name filter: ${q}`);
    assert.match(q, /trashed=false/);
  }
});

test("search builds name + fullText clauses from the query and drops stopwords", async () => {
  const queries: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q") ?? "");
    return Response.json({ files: [{ id: "f1", name: "ECON hw", mimeType: "application/pdf" }] });
  }) as typeof fetch;

  const files = await createDriveClient(fetchImpl).search("tok", "what is due for ECON 1110?", 10);
  assert.equal(files[0]?.id, "f1");
  const q = queries[0] ?? "";
  assert.match(q, /name contains 'econ'/);
  assert.match(q, /fullText contains 'econ'/);
  assert.match(q, /name contains '1110'/);
  assert.ok(!q.includes("'for'"), "stopwords should not become search terms");
});

test("inventory pages through Drive and resolves folder paths", async () => {
  const seenTokens: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const q = url.searchParams.get("q") ?? "";
    const token = url.searchParams.get("pageToken");
    if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
      return Response.json({
        files: [
          { id: "root1", name: "School", mimeType: "application/vnd.google-apps.folder" },
          {
            id: "sub1",
            name: "Spring",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["root1"],
          },
        ],
      });
    }
    seenTokens.push(token);
    if (!token) {
      return Response.json({
        nextPageToken: "page-2",
        files: [{ id: "a", name: "a.pdf", mimeType: "application/pdf", parents: ["sub1"] }],
      });
    }
    return Response.json({
      files: [{ id: "b", name: "b.docx", mimeType: "application/octet-stream" }],
    });
  }) as typeof fetch;

  const page = await createDriveClient(fetchImpl).inventory("tok", { maxFiles: 500 });
  assert.deepEqual(seenTokens, [null, "page-2"]);
  assert.deepEqual(page.files.map((f) => f.id), ["a", "b"]);
  assert.equal(page.files[0]?.folderPath, "School/Spring");
  assert.equal(page.nextPageToken, null);
  assert.equal(page.truncated, false);
  assert.equal(page.folderCount, 2);
});

test("inventory reports truncation and a resume token when capped", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if ((url.searchParams.get("q") ?? "").includes("mimeType='application/vnd.google-apps.folder'")) {
      return Response.json({ files: [] });
    }
    return Response.json({
      nextPageToken: "more",
      files: [{ id: "a", name: "a.pdf", mimeType: "application/pdf" }],
    });
  }) as typeof fetch;

  const page = await createDriveClient(fetchImpl).inventory("tok", { maxFiles: 1 });
  assert.equal(page.truncated, true);
  assert.equal(page.nextPageToken, "more");
});

test("formatDriveInventory groups by folder and honours the character budget", () => {
  const files: DriveFile[] = [
    { id: "1", name: "a.pdf", mimeType: "application/pdf", folderPath: "School/Spring", modifiedTime: "2026-10-03T00:00:00Z" },
    { id: "2", name: "b.docx", mimeType: "application/octet-stream", folderPath: "School/Spring", modifiedTime: "2026-10-02T00:00:00Z" },
    { id: "3", name: "c.txt", mimeType: "text/plain", modifiedTime: "2026-10-01T00:00:00Z" },
  ];
  const full = formatDriveInventory(files);
  assert.match(full, /School\/Spring\/ — a\.pdf \(pdf\), b\.docx \(docx\)/);
  assert.match(full, /\(My Drive root\)\/ — c\.txt \(text\)/);

  // Tight budget: the most recent file survives, the rest are dropped with a
  // pointer to search rather than silently disappearing.
  const clipped = formatDriveInventory(files, { maxChars: 150 });
  assert.match(clipped, /a\.pdf/);
  assert.ok(!clipped.includes("c.txt"), "oldest file should fall outside the budget");
  assert.match(clipped, /1 more file\(s\) not listed here/);
});

test("summarizeDriveFilesWithExcerpts downloads PDF and attaches excerpt", async () => {
  const path = join(tmpdir(), `waypoint-drive-sum-${Date.now()}.pdf`);
  writeTinyPdf(path, "Syllabus Week 3");
  const pdfBytes = readFileSync(path);

  const files: DriveFile[] = [
    { id: "pdf1", name: "BIOMG1350.pdf", mimeType: "application/pdf" },
    {
      id: "doc1",
      name: "plan",
      mimeType: "application/vnd.google-apps.document",
    },
  ];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/export")) {
      return new Response("Exported Google Doc body", { status: 200 });
    }
    if (url.includes("alt=media")) {
      return new Response(pdfBytes, { status: 200 });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;

  const drive = createDriveClient(fetchImpl);
  const summary = await summarizeDriveFilesWithExcerpts(
    drive,
    "tok",
    files,
    "Drive:",
    { maxCharsPerFile: 500, maxExcerptFiles: 2 },
  );
  assert.match(summary, /FILE INVENTORY/);
  assert.match(summary, /BIOMG1350\.pdf/);
  assert.match(summary, /Syllabus Week 3/);
  assert.match(summary, /Exported Google Doc body/);
  assert.match(summary, /TEXT EXCERPTS|Excerpt/i);
});
