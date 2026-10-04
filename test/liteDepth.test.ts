import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunkWithOverlap,
  filterTableRows,
  formatStructuredList,
  parseDelimitedTable,
  planLiteChunks,
  prepareLiteDepthContext,
  splitIntoSections,
} from "../src/drive/liteDepth.ts";

test("parseDelimitedTable reads CSV with headers", () => {
  const csv = "item,status,qty\nHarness,active,3\nCarabiner,active,12\nRope,retired,1";
  const table = parseDelimitedTable(csv);
  assert.ok(table);
  assert.deepEqual(table.headers, ["item", "status", "qty"]);
  assert.equal(table.rows.length, 3);
});

test("filterTableRows excludes retired when utterance asks", () => {
  const csv = "item,status,qty\nHarness,active,3\nRope,retired,1";
  const table = parseDelimitedTable(csv)!;
  const filtered = filterTableRows(
    table.headers,
    table.rows,
    "list all gear excluding retired items",
  );
  assert.equal(filtered.length, 1);
  assert.match(filtered[0]![0]!, /Harness/i);
});

test("prepareLiteDepthContext builds complete structured list for inventory lines", async () => {
  const block = await prepareLiteDepthContext({
    fileTexts: [
      {
        name: "CRCC Gear Inventory",
        mimeType: "text/plain",
        text: "Row 12: harness — 3 available\nRow 18: carabiners — 12 available",
      },
    ],
    utterance: "list my gear inventory",
    liteModel: "gemini-3.5-flash-lite",
  });
  assert.match(block, /STRUCTURED LIST \(complete, 2 items\)/);
  assert.match(block, /carabiners — 12 available/);
});

test("formatStructuredList preserves every row", () => {
  const block = formatStructuredList(
    "gear.csv",
    ["item", "status"],
    [
      ["A", "active"],
      ["B", "active"],
    ],
  );
  assert.match(block, /complete, 2 items/);
  assert.match(block, /item: A/);
  assert.match(block, /item: B/);
});

test("splitIntoSections uses local headings", () => {
  const sections = splitIntoSections(
    "Intro paragraph here.\n\nGRADING POLICY\nHomework is 40%.\n\nWeek 3: Labs\nLab report due Friday Sep 12",
  );
  assert.ok(sections.length >= 2);
  assert.ok(sections.some((s) => /GRADING|Week 3/i.test(s.title)));
});

test("chunkWithOverlap covers full text without gaps", () => {
  const text = "a".repeat(10_000);
  const chunks = chunkWithOverlap(text, 4_000, 400);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0]!.length, 4_000);
  // Last chunk reaches the end.
  assert.ok(chunks.at(-1)!.endsWith("a"));
});

test("planLiteChunks section-packs a syllabus-like doc", () => {
  const body = [
    "BIOG 1111 Syllabus",
    "",
    "GRADING",
    "Exams 50%. Labs 30%. Homework 20%.",
    "",
    "Week 1: Intro",
    "Read chapter 1. Lab report due Friday Sep 12.",
    "",
    "Week 2: Cells",
    "Prelim 1: October 15",
  ].join("\n");
  const chunks = planLiteChunks(body);
  assert.ok(chunks.length >= 2);
});

test("prepareLiteDepthContext heuristically extracts syllabus facts without API key", async () => {
  const block = await prepareLiteDepthContext({
    fileTexts: [
      {
        name: "BIOG 1111 Syllabus.pdf",
        mimeType: "application/pdf",
        text: [
          "GRADING",
          "Homework weight: 20 percent of grade.",
          "Week 3 Labs",
          "Lab report due Friday Sep 12",
          "EXAMS",
          "Prelim 1: October 15",
        ].join("\n"),
      },
    ],
    utterance: "run through BIOG syllabus due dates",
    liteModel: "gemini-3.5-flash-lite",
  });
  assert.match(block, /LITE DEPTH|LOCAL OUTLINE/);
  assert.match(block, /STRUCTURED (FACTS|NOTES)/);
  assert.match(block, /Lab report due Friday Sep 12/);
  assert.match(block, /Prelim 1: October 15/);
});