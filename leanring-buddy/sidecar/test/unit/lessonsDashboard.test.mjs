import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-dashboard-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const { createWorkspace } = await import("../../src/workspaces.mjs");
const { regenerateLessonsDashboard, lessonsDashboardPath } = await import(
  "../../src/lessonsDashboard.mjs"
);

test("dashboard is created with an empty state when no topics exist", () => {
  const dashboardPath = regenerateLessonsDashboard();
  assert.equal(dashboardPath, join(sandboxRoot, "index.html"));
  assert.ok(existsSync(dashboardPath));
  const dashboardHtml = readFileSync(dashboardPath, "utf8");
  assert.ok(dashboardHtml.includes("No lessons yet"));
});

test("topics list every lesson as a relative link with the latest marked", () => {
  createWorkspace("Japanese");
  const lessonsDirectory = join(sandboxRoot, "japanese", "lessons");
  mkdirSync(lessonsDirectory, { recursive: true });
  writeFileSync(join(lessonsDirectory, "0001-hiragana.html"), "<html></html>");
  writeFileSync(join(lessonsDirectory, "0002-katakana.html"), "<html></html>");

  const dashboardHtml = readFileSync(regenerateLessonsDashboard(), "utf8");
  assert.ok(dashboardHtml.includes("Japanese"));
  assert.ok(dashboardHtml.includes('href="japanese/lessons/0001-hiragana.html"'));
  assert.ok(dashboardHtml.includes('href="japanese/lessons/0002-katakana.html"'));
  // Latest lesson (highest number) carries the highlight class.
  const latestIndex = dashboardHtml.indexOf("0002-katakana.html");
  const highlightIndex = dashboardHtml.lastIndexOf('class="latest"', latestIndex);
  assert.ok(highlightIndex !== -1 && highlightIndex < latestIndex);
});

test("topic names are HTML-escaped", () => {
  createWorkspace("Tricks & <Tips>");
  const dashboardHtml = readFileSync(regenerateLessonsDashboard(), "utf8");
  assert.ok(dashboardHtml.includes("Tricks &amp; &lt;Tips&gt;"));
});
