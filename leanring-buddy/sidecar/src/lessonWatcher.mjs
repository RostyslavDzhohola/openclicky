// Lesson-file watcher.
//
// The teach skill writes lessons as <workspace>/lessons/NNNN-name.html. A
// completed teach turn owns the decision about who opens a new lesson: lesson
// events found while that turn is in flight are held until its shell-command
// list is complete. This prevents an early watcher verdict from racing an
// agent's final `open` command and creating two browser tabs.

import chokidar from "chokidar";
import { basename, sep } from "node:path";
import { emitEvent, emitLog as emitSidecarLog } from "./protocol.mjs";
import { recentClaudeBashCommands } from "./claudeBackend.mjs";
import { recentCodexShellCommands } from "./codexBackend.mjs";
import { workspacePath } from "./workspaces.mjs";
import { regenerateLessonsDashboard } from "./lessonsDashboard.mjs";
import { traceAgentEvent } from "./agentTrace.mjs";

const LESSON_OPEN_GRACE_PERIOD_MS = 2_000;
const TEACH_TURN_HOLD_SAFETY_TIMEOUT_MS = 15 * 60 * 1_000;

/** workspaceId → chokidar watcher */
const activeWatchers = new Map();

/** workspaceId → backend of the most recent chat (for command attribution) */
const lastBackendForWorkspace = new Map();

function shellCommandsForWorkspace(workspaceId) {
  const backend = lastBackendForWorkspace.get(workspaceId) ?? "claude";
  return backend === "codex"
    ? recentCodexShellCommands(workspaceId)
    : recentClaudeBashCommands(workspaceId);
}

export function didAgentOpenLesson(shellCommands, lessonFileName) {
  return shellCommands.some(
    (command) => command.includes("open") && command.includes(lessonFileName)
  );
}

function truncatedCommandsForLog(shellCommands) {
  return shellCommands
    .map((command) => String(command).replace(/\r?\n/g, " ").slice(0, 120))
    .join(" | ");
}

/**
 * Coordinates stabilized lesson files independently from chokidar so the
 * command-attribution race can be tested without mocking filesystem events.
 */
export function createLessonEventCoordinator({
  getShellCommandsForWorkspace,
  regenerateDashboard,
  emitLessonCreatedEvent,
  emitLog,
  emitTrace = () => {},
  gracePeriodMs = LESSON_OPEN_GRACE_PERIOD_MS,
  holdSafetyTimeoutMs = TEACH_TURN_HOLD_SAFETY_TIMEOUT_MS,
}) {
  /** workspaceId → active, reference-counted teach turn hold */
  const activeTeachTurnHolds = new Map();

  function emitLessonCreated({ workspaceId, addedFilePath, wasHeld, heldForMs, correlation = {} }) {
    const lessonFileName = basename(addedFilePath);
    const shellCommands = getShellCommandsForWorkspace(workspaceId);
    const openedByAgent = didAgentOpenLesson(shellCommands, lessonFileName);
    const truncatedCommands = truncatedCommandsForLog(shellCommands);

    regenerateDashboard();
    emitTrace("lesson.emitted", {
      ...correlation,
      workspaceId,
      path: addedFilePath,
      openedByAgent,
      wasHeld,
      heldForMs: Math.round(heldForMs),
    });
    emitLog(
      "info",
      `lessonCreated ${lessonFileName} workspace=${workspaceId} openedByAgent=${openedByAgent} held=${wasHeld} heldForMs=${Math.round(heldForMs)} commands=[${truncatedCommands}]`
    );
    emitLessonCreatedEvent({
      type: "lessonCreated",
      workspaceId,
      path: addedFilePath,
      openedByAgent,
      ...correlation,
    });
  }

  function flushHeldLessons(workspaceId, activeTeachTurnHold) {
    const heldForMs = Date.now() - activeTeachTurnHold.startedAt;
    for (const queuedLesson of activeTeachTurnHold.queuedLessons) {
      emitLessonCreated({
        workspaceId,
        addedFilePath: queuedLesson.addedFilePath,
        wasHeld: true,
        heldForMs,
        correlation: activeTeachTurnHold.correlation,
      });
    }
  }

  function queueHeldLesson(workspaceId, addedFilePath) {
    const activeTeachTurnHold = activeTeachTurnHolds.get(workspaceId);
    if (!activeTeachTurnHold) return false;

    activeTeachTurnHold.queuedLessons.push({ addedFilePath });
    return true;
  }

  function beginTeachTurnHold(workspaceId, correlation = {}) {
    const existingTeachTurnHold = activeTeachTurnHolds.get(workspaceId);
    if (existingTeachTurnHold) {
      existingTeachTurnHold.referenceCount += 1;
      return;
    }

    const activeTeachTurnHold = {
      referenceCount: 1,
      startedAt: Date.now(),
      queuedLessons: [],
      correlation,
      safetyTimeout: null,
    };
    activeTeachTurnHold.safetyTimeout = setTimeout(() => {
      if (activeTeachTurnHolds.get(workspaceId) !== activeTeachTurnHold) return;

      activeTeachTurnHolds.delete(workspaceId);
      if (activeTeachTurnHold.shouldDiscardQueuedLessons) {
        emitLog(
          "info",
          `dropping ${activeTeachTurnHold.queuedLessons.length} queued lesson(s) for ${workspaceId}`
        );
        return;
      }
      emitLog(
        "warn",
        `teach turn hold for ${workspaceId} exceeded ${holdSafetyTimeoutMs}ms; safety-flushing ${activeTeachTurnHold.queuedLessons.length} queued lesson(s)`
      );
      flushHeldLessons(workspaceId, activeTeachTurnHold);
    }, holdSafetyTimeoutMs);
    // A crashed request must not keep the sidecar alive just for this backstop.
    activeTeachTurnHold.safetyTimeout.unref?.();
    activeTeachTurnHolds.set(workspaceId, activeTeachTurnHold);
    emitTrace("watcher.hold-started", { ...correlation, workspaceId });
  }

  function endTeachTurnHold(workspaceId, { discardQueuedLessons = false } = {}) {
    const activeTeachTurnHold = activeTeachTurnHolds.get(workspaceId);
    if (!activeTeachTurnHold) return;

    if (discardQueuedLessons) {
      activeTeachTurnHold.shouldDiscardQueuedLessons = true;
    }
    activeTeachTurnHold.referenceCount -= 1;
    if (activeTeachTurnHold.referenceCount > 0) return;

    activeTeachTurnHolds.delete(workspaceId);
    clearTimeout(activeTeachTurnHold.safetyTimeout);
    emitTrace("watcher.hold-ended", {
      ...activeTeachTurnHold.correlation,
      workspaceId,
      queuedLessonCount: activeTeachTurnHold.queuedLessons.length,
    });
    if (activeTeachTurnHold.shouldDiscardQueuedLessons) {
      emitLog(
        "info",
        `dropping ${activeTeachTurnHold.queuedLessons.length} queued lesson(s) for ${workspaceId}`
      );
    } else {
      flushHeldLessons(workspaceId, activeTeachTurnHold);
    }
  }

  function handleStabilizedLessonAdd({ workspaceId, addedFilePath }) {
    const activeTeachTurnHold = activeTeachTurnHolds.get(workspaceId);
    emitTrace("lesson.detected", {
      ...activeTeachTurnHold?.correlation,
      workspaceId,
      path: addedFilePath,
    });
    if (queueHeldLesson(workspaceId, addedFilePath)) return;

    // Lessons written outside a tracked teach turn retain the existing grace
    // period, which gives a nearby agent `open` command time to be recorded.
    setTimeout(() => {
      // A teach turn might have begun during the grace period. In that case
      // defer to the complete-turn verdict rather than emitting prematurely.
      if (queueHeldLesson(workspaceId, addedFilePath)) return;
      emitLessonCreated({
        workspaceId,
        addedFilePath,
        wasHeld: false,
        heldForMs: 0,
      });
    }, gracePeriodMs);
  }

  return {
    beginTeachTurnHold,
    endTeachTurnHold,
    handleStabilizedLessonAdd,
  };
}

const lessonEventCoordinator = createLessonEventCoordinator({
  getShellCommandsForWorkspace: shellCommandsForWorkspace,
  regenerateDashboard: regenerateLessonsDashboard,
  emitLessonCreatedEvent: emitEvent,
  emitLog: emitSidecarLog,
  emitTrace: traceAgentEvent,
});

export function beginTeachTurnHold(workspaceId, correlation) {
  lessonEventCoordinator.beginTeachTurnHold(workspaceId, correlation);
}

export function endTeachTurnHold(workspaceId, { discardQueuedLessons = false } = {}) {
  lessonEventCoordinator.endTeachTurnHold(workspaceId, { discardQueuedLessons });
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
    lessonEventCoordinator.handleStabilizedLessonAdd({ workspaceId, addedFilePath });
  });

  watcher.on("error", (watcherError) => {
    emitSidecarLog("warn", `lesson watcher error for ${workspaceId}: ${watcherError?.message}`);
    // Drop the broken watcher so the next chat in this workspace re-arms a
    // fresh one — otherwise lesson notifications stop silently forever.
    watcher.close().catch(() => {});
    activeWatchers.delete(workspaceId);
  });

  activeWatchers.set(workspaceId, watcher);
}
