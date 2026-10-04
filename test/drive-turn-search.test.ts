import assert from "node:assert/strict";
import test from "node:test";

import {
  driveSearchQueries,
  fetchDriveExcerptsForTurn,
  inventoryFileNames,
  looksLikeOpenOrConfirm,
  isDeepOverviewIntent,
  looksLikeSyllabusCheck,
  wantsFullDriveLoad,
} from "../src/drive/turnSearch.ts";
import type { DriveClient, DriveFile } from "../src/drive/client.ts";
import { TurnBridge } from "../src/companion/liveSession.ts";

test("looksLikeOpenOrConfirm catches short voice confirms", () => {
  assert.equal(looksLikeOpenOrConfirm("Yep. Please do."), true);
  assert.equal(looksLikeOpenOrConfirm("Yes"), true);
  assert.equal(looksLikeOpenOrConfirm("Yes, please open it."), true);
  assert.equal(looksLikeOpenOrConfirm("open that spreadsheet"), true);
  assert.equal(looksLikeOpenOrConfirm("What files do you have access to?"), false);
});

test("syllabus / due-date asks trigger full load", () => {
  assert.equal(looksLikeSyllabusCheck("run through my syllabi and confirm assignments this week"), true);
  assert.equal(wantsFullDriveLoad("check BIOL 1111 syllabus due dates"), true);
  assert.equal(wantsFullDriveLoad("Yes"), true);
});

test("isDeepOverviewIntent catches exhaustive list asks", () => {
  assert.equal(
    isDeepOverviewIntent("List all climbing gear excluding retired"),
    true,
  );
  assert.equal(isDeepOverviewIntent("What's the weather?"), false);
  assert.equal(isDeepOverviewIntent("Help me plan tomorrow"), false);
});

test("inventoryFileNames parses compact inventory lines", () => {
  const names = inventoryFileNames(
    "DRIVE INVENTORY\nClasses/ — BIOG 1111 Syllabus (pdf), CHEM 2070 Student Expectations (pdf)\n",
  );
  assert.ok(names.some((n) => /BIOG 1111/i.test(n)));
  assert.ok(names.some((n) => /CHEM 2070/i.test(n)));
});

test("driveSearchQueries expands Yes with prior BIOG mention + inventory", () => {
  const inventory =
    "Classes/ — BIOG 1111 Syllabus (pdf), CRCC Gear Inventory (gsheet)";
  const queries = driveSearchQueries(
    "Yes",
    [
      {
        role: "user",
        content: "Yeah, check in BIOL 1111. I'm pretty sure that syllabus lists every assignment.",
      },
      {
        role: "assistant",
        content:
          "I see your BIOG 1111 syllabus in Drive, but its text excerpts are not loaded right now. Want me to pull up the full contents?",
      },
    ],
    inventory,
  );
  assert.ok(queries.some((q) => /BIOG|BIOL|1111|syllabus/i.test(q)), queries.join(" | "));
});

test("TurnBridge does not stack utterances after clearUserTurn", () => {
  const bridge = new TurnBridge();
  bridge.handle({ kind: "final_user", text: "list my gear inventory" });
  bridge.clearUserTurn();
  const second = bridge.handle({ kind: "final_user", text: "Yep. Please do." });
  assert.equal(second[0]?.type, "user");
  if (second[0]?.type === "user") {
    assert.equal(second[0].text, "Yep. Please do.");
    assert.doesNotMatch(second[0].text, /list my gear/);
  }
});

test("fetchDriveExcerptsForTurn loads FULL syllabus text on Yes", async () => {
  const files: DriveFile[] = [
    {
      id: "syl1",
      name: "BIOG 1111 Syllabus",
      mimeType: "application/pdf",
    },
  ];
  const longBody = [
    "BIOG 1111 Introductory Biology",
    "Week 1: Reading quiz due Monday",
    "Week 2: Lab report due Friday Sep 12",
    "Week 3: Problem set 1 due Wednesday",
    "Prelim 1: October 15",
  ].join("\n");

  const drive: DriveClient = {
    async listRecent() {
      return [];
    },
    async search(_token, query) {
      return /biog|biol|1111|syllabus|yes/i.test(query) ? files : [];
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
      assert.ok((options?.maxChars ?? 0) >= 10_000, "full open should request large maxChars");
      return { ok: true, kind: "pdf", text: longBody };
    },
  };

  const summary = await fetchDriveExcerptsForTurn(
    { drive, accessToken: "tok" },
    "Yes",
    [
      {
        role: "user",
        content: "check BIOL 1111 — that syllabus lists every assignment due date",
      },
      {
        role: "assistant",
        content: "I see your BIOG 1111 syllabus. Want me to pull up the full contents?",
      },
    ],
    { inventory: "Classes/ — BIOG 1111 Syllabus (pdf)" },
  );
  assert.match(summary, /LITE DEPTH|STRUCTURED (FACTS|NOTES|LIST)/i);
  assert.match(summary, /Lab report due Friday/);
  assert.match(summary, /Prelim 1: October 15/);
  assert.doesNotMatch(summary, /do not claim you checked/i);
});

test("syllabus check with no hits tells the model not to fake a review", async () => {
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
    async readFileText() {
      return { ok: false, reason: "unused" };
    },
  };
  const summary = await fetchDriveExcerptsForTurn(
    { drive, accessToken: "tok" },
    "run through my syllabi and confirm I have no assignments this week",
    [],
  );
  assert.match(summary, /do not claim you checked/i);
});
