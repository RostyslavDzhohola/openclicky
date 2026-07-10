// Active background lesson-build registry and cancellation cleanup helpers.
// Keeping this state machine independent from index.mjs makes cancellation
// ordering and file cleanup testable without starting either AI backend.

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const CANONICAL_LESSON_FILE_NAME_PATTERN = /^(\d{4})-.*\.html$/;

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
          directoryEntry.isFile() && CANONICAL_LESSON_FILE_NAME_PATTERN.test(directoryEntry.name)
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

export function quarantineLessonFilesCreatedDuringDispatch({
  lessonsDirectory,
  lessonFileNamesBeforeDispatch,
}) {
  const lessonFileNamesBeforeDispatchSet = new Set(lessonFileNamesBeforeDispatch);
  const lessonFileNamesAfterDispatch = listLessonFileNames(lessonsDirectory);
  const quarantinedLessonFileNames = [];

  for (const lessonFileName of lessonFileNamesAfterDispatch) {
    if (lessonFileNamesBeforeDispatchSet.has(lessonFileName)) {
      continue;
    }

    let quarantinedLessonFileName = `cancelled-${lessonFileName}`;
    let quarantineCollisionNumber = 2;
    while (existsSync(join(lessonsDirectory, quarantinedLessonFileName))) {
      quarantinedLessonFileName = `cancelled-${quarantineCollisionNumber}-${lessonFileName}`;
      quarantineCollisionNumber += 1;
    }
    // Renaming in place keeps potentially concurrent work recoverable while
    // removing it from every feature that recognizes canonical lesson names.
    renameSync(
      join(lessonsDirectory, lessonFileName),
      join(lessonsDirectory, quarantinedLessonFileName)
    );
    quarantinedLessonFileNames.push(quarantinedLessonFileName);
  }

  return quarantinedLessonFileNames;
}
