import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationSupportDirectory } from "../../src/appSupport.mjs";
import {
  clearPendingDispatch,
  loadPendingDispatchesForRecovery,
  recordPendingDispatch,
} from "../../src/teachDispatchQueue.mjs";

let applicationSupportSandboxDirectory;
let previousApplicationSupportDirectory;

function pendingDispatchEntry(overrides = {}) {
  return {
    id: "dispatch-1",
    backend: "codex",
    model: "gpt-5",
    topicText: "CSS Flexbox",
    instructions: "Create a lesson about alignment.",
    createdAt: Date.now(),
    ...overrides,
  };
}

function pendingDispatchesFilePath() {
  return join(applicationSupportDirectory(), "pending-teach-dispatches.json");
}

function assertNoTemporaryQueueFilesRemain() {
  const queueFileName = "pending-teach-dispatches.json";
  const temporaryQueueFileNames = readdirSync(applicationSupportDirectory()).filter((fileName) =>
    fileName.startsWith(`${queueFileName}.`) && fileName.endsWith(".tmp")
  );

  assert.deepEqual(temporaryQueueFileNames, []);
}

beforeEach(() => {
  previousApplicationSupportDirectory = process.env.CLICKY_APP_SUPPORT;
  applicationSupportSandboxDirectory = mkdtempSync(
    join(tmpdir(), "clicky-teach-dispatch-queue-test-")
  );
  process.env.CLICKY_APP_SUPPORT = applicationSupportSandboxDirectory;
});

afterEach(() => {
  if (previousApplicationSupportDirectory === undefined) {
    delete process.env.CLICKY_APP_SUPPORT;
  } else {
    process.env.CLICKY_APP_SUPPORT = previousApplicationSupportDirectory;
  }
  rmSync(applicationSupportSandboxDirectory, { recursive: true, force: true });
});

test("record and clear round-trip a pending dispatch entry", () => {
  const pendingDispatch = pendingDispatchEntry();
  recordPendingDispatch(pendingDispatch);
  assertNoTemporaryQueueFilesRemain();

  clearPendingDispatch("missing-dispatch");
  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [pendingDispatch],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();

  clearPendingDispatch(pendingDispatch.id);
  assertNoTemporaryQueueFilesRemain();
  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();
});

test("record replaces a pending dispatch with the same id", () => {
  recordPendingDispatch(pendingDispatchEntry({ instructions: "Create an introductory lesson." }));
  assertNoTemporaryQueueFilesRemain();
  const replacementPendingDispatch = pendingDispatchEntry({
    instructions: "Create an advanced lesson.",
    model: "gpt-5.1",
  });

  recordPendingDispatch(replacementPendingDispatch);
  assertNoTemporaryQueueFilesRemain();

  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [replacementPendingDispatch],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();
});

test("recovery drops stale dispatches from the durable queue and counts them", () => {
  const maximumDispatchAgeMilliseconds = 60_000;
  const freshPendingDispatch = pendingDispatchEntry({ id: "fresh-dispatch" });
  const stalePendingDispatch = pendingDispatchEntry({
    id: "stale-dispatch",
    createdAt: Date.now() - maximumDispatchAgeMilliseconds - 1,
  });
  recordPendingDispatch(freshPendingDispatch);
  assertNoTemporaryQueueFilesRemain();
  recordPendingDispatch(stalePendingDispatch);
  assertNoTemporaryQueueFilesRemain();

  assert.deepEqual(loadPendingDispatchesForRecovery(maximumDispatchAgeMilliseconds), {
    pendingDispatches: [freshPendingDispatch],
    droppedStaleCount: 1,
  });
  assert.deepEqual(JSON.parse(readFileSync(pendingDispatchesFilePath(), "utf8")), [freshPendingDispatch]);
  assertNoTemporaryQueueFilesRemain();
});

test("recovery retains fresh entries until their re-dispatched work settles", () => {
  const pendingDispatch = pendingDispatchEntry();
  recordPendingDispatch(pendingDispatch);
  assertNoTemporaryQueueFilesRemain();

  const firstRecoveryResult = loadPendingDispatchesForRecovery(60_000);
  assertNoTemporaryQueueFilesRemain();
  const secondRecoveryResult = loadPendingDispatchesForRecovery(60_000);
  assertNoTemporaryQueueFilesRemain();

  assert.deepEqual(firstRecoveryResult, {
    pendingDispatches: [pendingDispatch],
    droppedStaleCount: 0,
  });
  assert.deepEqual(secondRecoveryResult, {
    pendingDispatches: [pendingDispatch],
    droppedStaleCount: 0,
  });
  assert.deepEqual(JSON.parse(readFileSync(pendingDispatchesFilePath(), "utf8")), [pendingDispatch]);
  assertNoTemporaryQueueFilesRemain();
});

test("clearing a recovered dispatch removes it after its work settles", () => {
  const recoveredPendingDispatch = pendingDispatchEntry();
  recordPendingDispatch(recoveredPendingDispatch);
  assertNoTemporaryQueueFilesRemain();

  assert.deepEqual(loadPendingDispatchesForRecovery(60_000).pendingDispatches, [recoveredPendingDispatch]);
  assertNoTemporaryQueueFilesRemain();
  clearPendingDispatch(recoveredPendingDispatch.id);
  assertNoTemporaryQueueFilesRemain();

  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();
});

test("corrupt queue files are treated as an empty queue", () => {
  mkdirSync(applicationSupportDirectory(), { recursive: true });
  writeFileSync(pendingDispatchesFilePath(), "this is not JSON");

  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();
});

test("a missing queue file is treated as an empty queue", () => {
  assert.deepEqual(loadPendingDispatchesForRecovery(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
  assertNoTemporaryQueueFilesRemain();
});
