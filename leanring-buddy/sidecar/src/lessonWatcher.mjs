// Lesson-file watcher.
//
// The teach skill writes lessons as <workspace>/lessons/NNNN-name.html and
// (per its own instructions) usually opens them itself with a Bash `open`
// command. We watch the lessons directory and emit a lessonCreated event
// with an openedByAgent flag, computed by scanning the shell commands the
// current/most recent turn actually ran. The app opens the file only when
// the agent didn't — so exactly one browser tab appears either way.

import chokidar from "chokidar";
import { basename, sep } from "node:path";
import { emitEvent, emitLog } from "./protocol.mjs";
import { recentClaudeBashCommands } from "./claudeBackend.mjs";
import { recentCodexShellCommands } from "./codexBackend.mjs";
import { workspacePath } from "./workspaces.mjs";
import { regenerateLessonsDashboard } from "./lessonsDashboard.mjs";

/** workspaceId → chokidar watcher */
const activeWatchers = new Map();

/** workspaceId → backend of the most recent chat (for command attribution) */
const lastBackendForWorkspace = new Map();

function didAgentOpenLesson(workspaceId, lessonFileName) {
  const backend = lastBackendForWorkspace.get(workspaceId) ?? "claude";
  const shellCommands =
    backend === "codex"
      ? recentCodexShellCommands(workspaceId)
      : recentClaudeBashCommands(workspaceId);
  return shellCommands.some(
    (command) => command.includes("open") && command.includes(lessonFileName)
  );
}

export function watchWorkspaceLessons(workspaceId, backend) {
  lastBackendForWorkspace.set(workspaceId, backend ?? "claude");

  if (activeWatchers.has(workspaceId)) {
    return;
  }

  // Watch the workspace ROOT rather than lessons/ directly: chokidar v4
  // never fires for contents of a directory that did not exist when the
  // watch started, and lessons/ is created lazily by the teach skill.
  const watcher = chokidar.watch(workspacePath(workspaceId), {
    ignoreInitial: true,
    depth: 2,
    // Lessons are written incrementally by the agent; wait for the file to
    // stop growing before announcing it, so we never open a half-written page.
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
  });

  watcher.on("add", (addedFilePath) => {
    if (!addedFilePath.endsWith(".html")) return;
    if (!addedFilePath.includes(`${sep}lessons${sep}`)) return;
    const lessonFileName = basename(addedFilePath);
    // Give the agent's own `open` command a moment to be observed before
    // we decide who is responsible for opening the lesson.
    setTimeout(() => {
      regenerateLessonsDashboard();
      emitEvent({
        type: "lessonCreated",
        workspaceId,
        path: addedFilePath,
        openedByAgent: didAgentOpenLesson(workspaceId, lessonFileName),
      });
    }, 2000);
  });

  watcher.on("error", (watcherError) => {
    emitLog("warn", `lesson watcher error for ${workspaceId}: ${watcherError?.message}`);
    // Drop the broken watcher so the next chat in this workspace re-arms a
    // fresh one — otherwise lesson notifications stop silently forever.
    watcher.close().catch(() => {});
    activeWatchers.delete(workspaceId);
  });

  activeWatchers.set(workspaceId, watcher);
}
