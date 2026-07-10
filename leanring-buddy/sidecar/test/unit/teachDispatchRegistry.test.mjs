import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTeachDispatchRegistry,
  listLessonFileNames,
  removeLessonFilesCreatedDuringDispatch,
} from "../../src/teachDispatchRegistry.mjs";

function createDispatchArguments(requestId = "teach-dispatch-one") {
  return {
    workspaceId: "japanese",
    requestId,
    backend: "claude",
    topicText: "Japanese",
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((deferredResolve) => {
    resolve = deferredResolve;
  });
  return { promise, resolve };
}

test("beginDispatch registers one active dispatch per workspace", () => {
  const registry = createTeachDispatchRegistry();
  const dispatchArguments = createDispatchArguments();

  const entry = registry.beginDispatch(dispatchArguments);

  assert.deepEqual(
    {
      workspaceId: entry.workspaceId,
      requestId: entry.requestId,
      backend: entry.backend,
      topicText: entry.topicText,
      cancellationRequested: entry.cancellationRequested,
    },
    { ...dispatchArguments, cancellationRequested: false }
  );
  assert.equal(registry.activeDispatch("japanese"), entry);
  assert.equal(
    registry.beginDispatch(createDispatchArguments("teach-dispatch-duplicate")),
    null
  );
});

test("settleDispatch frees the workspace for a new dispatch", () => {
  const registry = createTeachDispatchRegistry();
  const firstEntry = registry.beginDispatch(createDispatchArguments());

  registry.settleDispatch("japanese", firstEntry);

  const secondEntry = registry.beginDispatch(
    createDispatchArguments("teach-dispatch-two")
  );
  assert.notEqual(secondEntry, null);
  assert.equal(registry.activeDispatch("japanese"), secondEntry);
});

test("requestCancellation returns false when no dispatch is active", async () => {
  const registry = createTeachDispatchRegistry();
  let cancellationCallCount = 0;

  const wasCancellationRequested = await registry.requestCancellation("japanese", {
    cancelBackendTurn: async () => {
      cancellationCallCount += 1;
    },
  });

  assert.equal(wasCancellationRequested, false);
  assert.equal(cancellationCallCount, 0);
});

test("requestCancellation waits for dispatch cleanup after cancelling the backend turn", async () => {
  const registry = createTeachDispatchRegistry();
  const entry = registry.beginDispatch(createDispatchArguments());
  let cancellationEntry = null;
  let cancellationPromiseResolved = false;
  const backendCancellationDeferred = createDeferred();

  const cancellationPromise = registry
    .requestCancellation("japanese", {
      cancelBackendTurn: async (activeEntry) => {
        cancellationEntry = activeEntry;
        await backendCancellationDeferred.promise;
      },
    })
    .then((wasCancellationRequested) => {
      cancellationPromiseResolved = true;
      return wasCancellationRequested;
    });

  await Promise.resolve();
  assert.equal(entry.cancellationRequested, true);
  assert.equal(cancellationEntry, entry);
  assert.equal(cancellationPromiseResolved, false);

  backendCancellationDeferred.resolve();
  await Promise.resolve();
  assert.equal(cancellationPromiseResolved, false);

  registry.settleDispatch("japanese", entry);

  assert.equal(await cancellationPromise, true);
  assert.equal(cancellationPromiseResolved, true);
});

test("requestCancellation still waits for cleanup when backend cancellation fails", async () => {
  const registry = createTeachDispatchRegistry();
  const entry = registry.beginDispatch(createDispatchArguments());
  let cancellationPromiseRejected = false;

  const cancellationPromise = registry
    .requestCancellation("japanese", {
      cancelBackendTurn: async () => {
        throw new Error("interrupt failed");
      },
    })
    .catch((cancellationError) => {
      cancellationPromiseRejected = true;
      throw cancellationError;
    });

  await Promise.resolve();
  assert.equal(entry.cancellationRequested, true);
  assert.equal(cancellationPromiseRejected, false);

  registry.settleDispatch("japanese", entry);

  await assert.rejects(cancellationPromise, /interrupt failed/);
  assert.equal(cancellationPromiseRejected, true);
});

function createLessonsSandbox() {
  const sandboxDirectory = mkdtempSync(join(tmpdir(), "clicky-dispatch-registry-test-"));
  const lessonsDirectory = join(sandboxDirectory, "lessons");
  mkdirSync(lessonsDirectory);
  return { sandboxDirectory, lessonsDirectory };
}

test("lesson cleanup removes only new matching files directly inside the lessons directory", () => {
  const { lessonsDirectory } = createLessonsSandbox();
  writeFileSync(join(lessonsDirectory, "0001-existing.html"), "existing lesson");
  writeFileSync(join(lessonsDirectory, "notes.txt"), "notes");
  const nestedDirectory = join(lessonsDirectory, "nested");
  mkdirSync(nestedDirectory);
  writeFileSync(join(nestedDirectory, "0003-nested.html"), "nested lesson");

  const lessonFileNamesBeforeDispatch = listLessonFileNames(lessonsDirectory);
  writeFileSync(join(lessonsDirectory, "0002-new.HTML"), "new lesson");
  writeFileSync(join(lessonsDirectory, "draft.html"), "non-lesson html");

  const removedFileNames = removeLessonFilesCreatedDuringDispatch({
    lessonsDirectory,
    lessonFileNamesBeforeDispatch,
  });

  assert.deepEqual(lessonFileNamesBeforeDispatch, ["0001-existing.html"]);
  assert.deepEqual(removedFileNames, ["0002-new.HTML"]);
  assert.equal(readFileSync(join(lessonsDirectory, "0001-existing.html"), "utf8"), "existing lesson");
  assert.equal(readFileSync(join(lessonsDirectory, "notes.txt"), "utf8"), "notes");
  assert.equal(readFileSync(join(lessonsDirectory, "draft.html"), "utf8"), "non-lesson html");
  assert.equal(readFileSync(join(nestedDirectory, "0003-nested.html"), "utf8"), "nested lesson");
});

test("lesson filesystem helpers tolerate a missing lessons directory", () => {
  const sandboxDirectory = mkdtempSync(join(tmpdir(), "clicky-dispatch-registry-test-"));
  const missingLessonsDirectory = join(sandboxDirectory, "lessons");

  assert.deepEqual(listLessonFileNames(missingLessonsDirectory), []);
  assert.deepEqual(
    removeLessonFilesCreatedDuringDispatch({
      lessonsDirectory: missingLessonsDirectory,
      lessonFileNamesBeforeDispatch: [],
    }),
    []
  );
});
