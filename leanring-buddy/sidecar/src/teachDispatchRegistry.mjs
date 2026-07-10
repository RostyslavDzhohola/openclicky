// Active background lesson-build registry and cancellation cleanup helpers.
// Keeping this state machine independent from index.mjs makes cancellation
// ordering and file cleanup testable without starting either AI backend.

import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LESSON_FILE_NAME_PATTERN = /^(\d{4})-.*\.html$/i;

export function createTeachDispatchRegistry() {
  const activeDispatchesByWorkspaceId = new Map();

  function beginDispatch({ workspaceId, requestId, backend, topicText }) {
    if (activeDispatchesByWorkspaceId.has(workspaceId)) {
      return null;
    }

    let resolveCompletion;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const entry = {
      workspaceId,
      requestId,
      backend,
      topicText,
      cancellationRequested: false,
    };
    activeDispatchesByWorkspaceId.set(workspaceId, {
      entry,
      completionPromise,
      resolveCompletion,
    });
    return entry;
  }

  function activeDispatch(workspaceId) {
    return activeDispatchesByWorkspaceId.get(workspaceId)?.entry ?? null;
  }

  async function requestCancellation(workspaceId, { cancelBackendTurn }) {
    const registeredDispatch = activeDispatchesByWorkspaceId.get(workspaceId);
    if (!registeredDispatch) {
      return false;
    }

    registeredDispatch.entry.cancellationRequested = true;
    try {
      await cancelBackendTurn(registeredDispatch.entry);
    } finally {
      // Opening "latest" must wait until the cancelled build's durable record,
      // watcher hold, and any partially written lesson files are cleaned up.
      await registeredDispatch.completionPromise;
    }
    return true;
  }

  function settleDispatch(workspaceId, entry) {
    const registeredDispatch = activeDispatchesByWorkspaceId.get(workspaceId);
    if (registeredDispatch?.entry !== entry) {
      return;
    }

    activeDispatchesByWorkspaceId.delete(workspaceId);
    registeredDispatch.resolveCompletion();
  }

  return {
    beginDispatch,
    activeDispatch,
    requestCancellation,
    settleDispatch,
  };
}

export function listLessonFileNames(lessonsDirectory) {
  try {
    return readdirSync(lessonsDirectory, { withFileTypes: true })
      .filter(
        (directoryEntry) =>
          directoryEntry.isFile() && LESSON_FILE_NAME_PATTERN.test(directoryEntry.name)
      )
      .map((directoryEntry) => directoryEntry.name)
      .sort();
  } catch (readError) {
    if (readError?.code === "ENOENT") {
      return [];
    }
    throw readError;
  }
}

export function removeLessonFilesCreatedDuringDispatch({
  lessonsDirectory,
  lessonFileNamesBeforeDispatch,
}) {
  const lessonFileNamesBeforeDispatchSet = new Set(lessonFileNamesBeforeDispatch);
  const lessonFileNamesAfterDispatch = listLessonFileNames(lessonsDirectory);
  const removedLessonFileNames = [];

  for (const lessonFileName of lessonFileNamesAfterDispatch) {
    if (lessonFileNamesBeforeDispatchSet.has(lessonFileName)) {
      continue;
    }

    // lessonFileName came directly from a non-recursive directory listing and
    // passed the lesson pattern, so cleanup cannot escape or traverse folders.
    unlinkSync(join(lessonsDirectory, lessonFileName));
    removedLessonFileNames.push(lessonFileName);
  }

  return removedLessonFileNames;
}
