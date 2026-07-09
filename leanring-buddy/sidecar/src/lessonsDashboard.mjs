// Static lessons dashboard.
//
// A plain index.html at the lessons root that links every topic's lessons.
// No server, no JavaScript, no model calls — regenerated whenever a lesson
// or workspace changes, and opened by the app's "Lessons" button. Lessons
// are found by navigation, not conversation (design decision).

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERAL_WORKSPACE_ID,
  lessonsRootDirectory,
  listWorkspaces,
  workspacePath,
} from "./workspaces.mjs";

export function lessonsDashboardPath() {
  return join(lessonsRootDirectory(), "index.html");
}

function escapeHtml(rawText) {
  return String(rawText)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lessonFileNamesForTopic(workspaceId) {
  const lessonsDirectory = join(workspacePath(workspaceId), "lessons");
  if (!existsSync(lessonsDirectory)) return [];
  return readdirSync(lessonsDirectory)
    .filter((fileName) => fileName.endsWith(".html"))
    .sort();
}

function topicSectionHtml(workspace) {
  const lessonFileNames = lessonFileNamesForTopic(workspace.id);
  if (lessonFileNames.length === 0) {
    return `<section><h2>${escapeHtml(workspace.name)}</h2><p class="empty">No lessons yet — say "teach me ${escapeHtml(workspace.name)}" to start.</p></section>`;
  }
  const latestLessonFileName = lessonFileNames[lessonFileNames.length - 1];
  const lessonListItems = lessonFileNames
    .map((lessonFileName) => {
      const relativeHref = `${workspace.id}/lessons/${lessonFileName}`;
      const isLatest = lessonFileName === latestLessonFileName;
      return `<li${isLatest ? ' class="latest"' : ""}><a href="${escapeHtml(relativeHref)}">${escapeHtml(lessonFileName.replace(/\.html$/, ""))}</a>${isLatest ? " <em>latest</em>" : ""}</li>`;
    })
    .join("\n");
  return `<section><h2>${escapeHtml(workspace.name)}</h2><ol>\n${lessonListItems}\n</ol></section>`;
}

export function regenerateLessonsDashboard() {
  const topics = listWorkspaces().filter(
    (workspace) => workspace.id !== GENERAL_WORKSPACE_ID
  );

  const bodyHtml =
    topics.length === 0
      ? `<p class="empty">No lessons yet. Say "teach me &lt;topic&gt;" to Clicky to start your first one.</p>`
      : topics.map(topicSectionHtml).join("\n");

  const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenClicky Lessons</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; background: #111; color: #eee; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: #7ab8ff; text-decoration: none; } a:hover { text-decoration: underline; }
  li.latest a { font-weight: 600; } em { color: #888; font-style: normal; font-size: 0.85em; margin-left: 0.4em; }
  .empty { color: #999; }
</style>
</head>
<body>
<h1>OpenClicky Lessons</h1>
${bodyHtml}
</body>
</html>
`;

  const dashboardPath = lessonsDashboardPath();
  writeFileSync(dashboardPath, dashboardHtml);
  return dashboardPath;
}
