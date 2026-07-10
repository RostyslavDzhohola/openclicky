import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox BEFORE importing modules that read the env at call time.
const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-roster-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const { createWorkspace } = await import("../../src/workspaces.mjs");
const { buildTopicRosterText, composeChatTurnText } = await import("../../src/topicRoster.mjs");

test("empty root produces the no-topics roster", () => {
  const rosterText = buildTopicRosterText();
  assert.ok(rosterText.includes("[topic roster]"));
  assert.ok(rosterText.includes("no lesson topics exist yet"));
  assert.ok(rosterText.includes("[end roster]"));
});

test("topics appear with slug and lesson count; general and dot-dirs are excluded", () => {
  createWorkspace("general");
  createWorkspace("CSS Flexbox");
  const lessonsDirectory = join(sandboxRoot, "css-flexbox", "lessons");
  mkdirSync(lessonsDirectory, { recursive: true });
  writeFileSync(join(lessonsDirectory, "0001-intro.html"), "<html></html>");
  writeFileSync(join(lessonsDirectory, "cancelled-0002-layout.html"), "<html></html>");
  mkdirSync(join(sandboxRoot, ".chat"), { recursive: true });

  const rosterText = buildTopicRosterText();
  assert.ok(rosterText.includes("CSS Flexbox"));
  assert.ok(rosterText.includes("(slug: css-flexbox)"));
  assert.ok(rosterText.includes("1 lesson"));
  assert.equal(rosterText.includes("general"), false);
  assert.equal(rosterText.includes(".chat"), false);
});

test("composeChatTurnText appends the roster after the transcript", () => {
  const composedText = composeChatTurnText("what topics do i have?", "[topic roster]\n[end roster]");
  assert.ok(composedText.startsWith("what topics do i have?"));
  assert.ok(composedText.endsWith("[end roster]"));
});
