import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_RULES } from "../../src/companionRules.mjs";
import { parseOpenTag, resolveOpenLessonPath } from "../../src/openTag.mjs";

test("open tag parses a topic slug and strips the spoken text", () => {
  const parsed = parseOpenTag("here's your latest japanese lesson. [OPEN:japanese]");

  assert.equal(parsed.cleanedText, "here's your latest japanese lesson.");
  assert.deepEqual(parsed.openRequest, { topicSlug: "japanese", lessonOrdinal: null });
});

test("open tag accepts a zero-padded ordinal", () => {
  const parsed = parseOpenTag("got it. [OPEN:japanese:0002]");

  assert.equal(parsed.cleanedText, "got it.");
  assert.deepEqual(parsed.openRequest, { topicSlug: "japanese", lessonOrdinal: "0002" });
});

test("open tag normalizes a bare ordinal number", () => {
  const parsed = parseOpenTag("got it. [ OPEN : japanese : 2 ]");

  assert.equal(parsed.cleanedText, "got it.");
  assert.deepEqual(parsed.openRequest, { topicSlug: "japanese", lessonOrdinal: "0002" });
});

test("malformed open tags are stripped without creating a request", () => {
  const parsed = parseOpenTag("hmm. [OPEN:] [OPEN:japanese:two] [OPEN:japanese:00002]");

  assert.equal(parsed.cleanedText, "hmm.");
  assert.equal(parsed.openRequest, null);
});

test("only the first valid open tag wins while every open tag is stripped", () => {
  const parsed = parseOpenTag("okay. [OPEN:japanese:0002] [OPEN:french] [OPEN:]");

  assert.deepEqual(parsed.openRequest, { topicSlug: "japanese", lessonOrdinal: "0002" });
  assert.equal(parsed.cleanedText.includes("[OPEN"), false);
});

test("text without an open tag is left untouched", () => {
  const responseText = "your next japanese lesson is still building.";
  const parsed = parseOpenTag(responseText);

  assert.equal(parsed.cleanedText, responseText);
  assert.equal(parsed.openRequest, null);
});

function createLessonsSandbox() {
  const lessonsRootDirectory = mkdtempSync(join(tmpdir(), "clicky-open-tag-test-"));
  const lessonsDirectory = join(lessonsRootDirectory, "japanese", "lessons");
  mkdirSync(lessonsDirectory, { recursive: true });
  return { lessonsRootDirectory, lessonsDirectory };
}

test("open resolution selects the newest filename ordinal rather than mtime", () => {
  const { lessonsRootDirectory, lessonsDirectory } = createLessonsSandbox();
  const firstLessonPath = join(lessonsDirectory, "0001-hiragana.html");
  const newestLessonPath = join(lessonsDirectory, "0003-kanji.html");
  writeFileSync(firstLessonPath, "first");
  writeFileSync(newestLessonPath, "newest");
  // Deliberately make lesson one newer on disk; filename ordinal is the API.
  utimesSync(firstLessonPath, new Date("2030-01-01"), new Date("2030-01-01"));
  utimesSync(newestLessonPath, new Date("2020-01-01"), new Date("2020-01-01"));

  assert.deepEqual(
    resolveOpenLessonPath({
      lessonsRootDirectory,
      topicSlug: "japanese",
      lessonOrdinal: null,
    }),
    { lessonPath: newestLessonPath, failureReason: null }
  );
});

test("open resolution finds a requested ordinal", () => {
  const { lessonsRootDirectory, lessonsDirectory } = createLessonsSandbox();
  const requestedLessonPath = join(lessonsDirectory, "0002-katakana.html");
  writeFileSync(requestedLessonPath, "lesson two");

  assert.deepEqual(
    resolveOpenLessonPath({
      lessonsRootDirectory,
      topicSlug: "japanese",
      lessonOrdinal: "0002",
    }),
    { lessonPath: requestedLessonPath, failureReason: null }
  );
});

test("open resolution reports an ordinal miss, empty lessons, and an unknown slug", () => {
  const { lessonsRootDirectory, lessonsDirectory } = createLessonsSandbox();
  writeFileSync(join(lessonsDirectory, "0001-hiragana.html"), "lesson one");
  mkdirSync(join(lessonsRootDirectory, "empty-topic", "lessons"), { recursive: true });

  assert.deepEqual(
    resolveOpenLessonPath({
      lessonsRootDirectory,
      topicSlug: "japanese",
      lessonOrdinal: "0002",
    }),
    { lessonPath: null, failureReason: "ordinal_not_found" }
  );
  assert.deepEqual(
    resolveOpenLessonPath({
      lessonsRootDirectory,
      topicSlug: "empty-topic",
      lessonOrdinal: null,
    }),
    { lessonPath: null, failureReason: "no_lessons" }
  );
  assert.deepEqual(
    resolveOpenLessonPath({
      lessonsRootDirectory,
      topicSlug: "missing-topic",
      lessonOrdinal: null,
    }),
    { lessonPath: null, failureReason: "unknown_slug" }
  );
});

test("companion rules reserve open requests for the OPEN tag instead of TEACH", () => {
  assert.match(COMPANION_RULES, /\[OPEN:topic-slug\]/);
  assert.match(COMPANION_RULES, /do not emit \[TEACH:\.\.\.\] and do not run shell commands/i);
});
