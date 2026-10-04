import assert from "node:assert/strict";
import test from "node:test";

import type { DriveClient, DriveFile } from "../src/drive/client.ts";
import {
  buildDeepBriefText,
  courseCodesFromText,
  isDeepOverviewIntent,
  isDigestCoversTurnIntent,
  needsExhaustiveFileLoad,
  selectFilesForBrief,
  DEEP_BRIEF_MAX_CHARS_PER_FILE,
} from "../src/drive/weekBrief.ts";

test("isDigestCoversTurnIntent skips gear/list but covers due-week asks", () => {
  assert.equal(isDigestCoversTurnIntent("what's due this week"), true);
  assert.equal(isDigestCoversTurnIntent("prioritize my homework"), true);
  assert.equal(
    isDigestCoversTurnIntent("list all rock climbing club equipment excluding retired"),
    false,
  );
  assert.equal(needsExhaustiveFileLoad("list all gear excluding retired"), true);
});

test("isDeepOverviewIntent detects due, prioritize, inventory, and list-all asks", () => {
  assert.equal(isDeepOverviewIntent("what's due this week"), true);
  assert.equal(isDeepOverviewIntent("prioritize everything for me"), true);
  assert.equal(
    isDeepOverviewIntent("list of all rock climbing club equipment excluding gear that's been retired"),
    true,
  );
  assert.equal(isDeepOverviewIntent("full rundown of the gear inventory"), true);
  assert.equal(isDeepOverviewIntent("how are you"), false);
  assert.equal(isDeepOverviewIntent("open Discord"), false);
});

test("courseCodesFromText pulls codes from calendar-style summaries", () => {
  const codes = courseCodesFromText(
    "TODAY:\n- 10:10: BIOG 1110 Lecture\n- 14:30: CHEM 2070 Lab\n",
  );
  assert.ok(codes.some((c) => /BIOG\s*1110/i.test(c)));
  assert.ok(codes.some((c) => /CHEM\s*2070/i.test(c)));
});

test("selectFilesForBrief picks every syllabus for calendar courses", () => {
  const inventoryFiles: DriveFile[] = [
    { id: "1", name: "BIOG 1110 Syllabus Fall 2025.pdf", mimeType: "application/pdf" },
    { id: "2", name: "CHEM 2070 Course Outline.pdf", mimeType: "application/pdf" },
    { id: "3", name: "PHYS 2207 Expectations.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { id: "4", name: "Random Notes.txt", mimeType: "text/plain" },
    { id: "5", name: "Outdoors Club Gear Inventory", mimeType: "application/vnd.google-apps.spreadsheet" },
  ];
  const calendarSummary =
    "UPCOMING CALENDAR — next 7 day(s)\nTODAY:\n- BIOG 1110 Lecture\n- CHEM 2070 Discussion\n";
  const selected = selectFilesForBrief({
    inventoryFiles,
    calendarSummary,
    utterance: "what's due this week across all my classes",
    searchHits: [],
  });
  const names = selected.map((f) => f.name);
  assert.ok(names.some((n) => /BIOG 1110/i.test(n)), names.join(" | "));
  assert.ok(names.some((n) => /CHEM 2070/i.test(n)), names.join(" | "));
  assert.equal(names.some((n) => /Random Notes/i.test(n)), false);
});

test("selectFilesForBrief picks topical inventory sheet for gear list ask", () => {
  const inventoryFiles: DriveFile[] = [
    { id: "a", name: "Finance Budget 2024.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { id: "b", name: "Rock Climbing Gear Inventory 2025", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "c", name: "Meeting Notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ];
  const selected = selectFilesForBrief({
    inventoryFiles,
    calendarSummary: "",
    utterance:
      "list of all rock climbing club equipment excluding gear that's been retired",
    searchHits: [],
  });
  assert.equal(selected.length, 1);
  assert.match(selected[0]!.name, /Gear Inventory/i);
});

test("buildDeepBrief includes every active gear row in structured list", async () => {
  const sheetText = [
    "Item,Qty,Status",
    "Dynamic rope 60m,2,active",
    "Quickdraw set,12,active",
    "Helmet A,4,active",
    "Helmet B,1,retired",
    "Crash pad large,3,active",
    "Old harness,1,retired",
  ].join("\n");

  const files: DriveFile[] = [
    {
      id: "gear",
      name: "Rock Climbing Gear Inventory",
      mimeType: "application/vnd.google-apps.spreadsheet",
    },
  ];

  const drive: DriveClient = {
    async listRecent() {
      return [];
    },
    async search() {
      return [];
    },
    async listFolder() {
      return [];
    },
    async findFolders() {
      return [];
    },
    async inventory() {
      return { files: [], nextPageToken: null, truncated: false, folderCount: 0 };
    },
    async readFileText(_token, file, options) {
      assert.equal(file.id, "gear");
      assert.ok((options?.maxChars ?? 0) >= DEEP_BRIEF_MAX_CHARS_PER_FILE - 1);
      return { ok: true, kind: "google-sheets", text: sheetText };
    },
  };

  const brief = await buildDeepBriefText({
    drive,
    accessToken: "tok",
    files,
    utterance: "list all climbing equipment excluding retired",
    calendarSummary: "(no events)",
  });

  assert.match(brief, /DEEP BRIEF/);
  assert.match(brief, /STRUCTURED LIST \(complete, 4 items\)/);
  assert.match(brief, /Dynamic rope 60m/);
  assert.match(brief, /Quickdraw set/);
  assert.match(brief, /Crash pad large/);
  assert.doesNotMatch(brief, /Helmet B.*retired/);
  assert.match(brief, /MUST present every row in STRUCTURED LIST|identifying fields \+ counts/i);
  assert.match(brief, /FORBID 1–2 sentence category summaries|FORBID 1-2 sentence category/i);
  assert.match(brief, /first inventory reply is already the full itemized list/i);
});

test("buildDeepBrief loads multiple syllabi with large maxChars", async () => {
  const bodies: Record<string, string> = {
    syl1: "BIOG 1110\nPS1 due Mon\nPrelim Oct 1",
    syl2: "CHEM 2070\nLab report due Tue\nQuiz Fri",
  };

  const files: DriveFile[] = [
    { id: "syl1", name: "BIOG 1110 Syllabus.pdf", mimeType: "application/pdf" },
    { id: "syl2", name: "CHEM 2070 Course Outline.pdf", mimeType: "application/pdf" },
  ];

  let loadCount = 0;
  const drive: DriveClient = {
    async listRecent() {
      return [];
    },
    async search() {
      return [];
    },
    async listFolder() {
      return [];
    },
    async findFolders() {
      return [];
    },
    async inventory() {
      return { files: [], nextPageToken: null, truncated: false, folderCount: 0 };
    },
    async readFileText(_token, file) {
      loadCount += 1;
      return { ok: true, kind: "pdf", text: bodies[file.id] ?? "" };
    },
  };

  const brief = await buildDeepBriefText({
    drive,
    accessToken: "tok",
    files,
    utterance: "what's due this week",
    calendarSummary: "TODAY: BIOG 1110 and CHEM 2070",
  });

  assert.equal(loadCount, 2);
  assert.match(brief, /BIOG 1110 Syllabus/);
  assert.match(brief, /CHEM 2070 Course Outline/);
  assert.match(brief, /PS1 due Mon/);
  assert.match(brief, /Lab report due Tue/);
});
