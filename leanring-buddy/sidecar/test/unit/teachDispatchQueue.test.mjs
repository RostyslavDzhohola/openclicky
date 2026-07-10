import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationSupportDirectory } from "../../src/appSupport.mjs";
import {
  clearPendingDispatch,
  recordPendingDispatch,
  takePendingDispatches,
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

test("record, clear, and take preserve pending dispatch entries", () => {
  const pendingDispatch = pendingDispatchEntry();
  recordPendingDispatch(pendingDispatch);

  clearPendingDispatch("missing-dispatch");
  const firstTakeResult = takePendingDispatches(60_000);
  assert.deepEqual(firstTakeResult, {
    pendingDispatches: [pendingDispatch],
    droppedStaleCount: 0,
  });

  recordPendingDispatch(pendingDispatch);
  clearPendingDispatch(pendingDispatch.id);
  assert.deepEqual(takePendingDispatches(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
});

test("record replaces a pending dispatch with the same id", () => {
  recordPendingDispatch(pendingDispatchEntry({ instructions: "Create an introductory lesson." }));
  const replacementPendingDispatch = pendingDispatchEntry({
    instructions: "Create an advanced lesson.",
    model: "gpt-5.1",
  });

  recordPendingDispatch(replacementPendingDispatch);

  assert.deepEqual(takePendingDispatches(60_000), {
    pendingDispatches: [replacementPendingDispatch],
    droppedStaleCount: 0,
  });
});

test("take discards stale dispatches and returns fresh dispatches", () => {
  const maximumDispatchAgeMilliseconds = 60_000;
  const freshPendingDispatch = pendingDispatchEntry({ id: "fresh-dispatch" });
  const stalePendingDispatch = pendingDispatchEntry({
    id: "stale-dispatch",
    createdAt: Date.now() - maximumDispatchAgeMilliseconds - 1,
  });
  recordPendingDispatch(freshPendingDispatch);
  recordPendingDispatch(stalePendingDispatch);

  assert.deepEqual(takePendingDispatches(maximumDispatchAgeMilliseconds), {
    pendingDispatches: [freshPendingDispatch],
    droppedStaleCount: 1,
  });
});

test("take empties the queue after returning pending dispatches", () => {
  recordPendingDispatch(pendingDispatchEntry());

  takePendingDispatches(60_000);

  assert.deepEqual(takePendingDispatches(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
  assert.deepEqual(JSON.parse(readFileSync(pendingDispatchesFilePath(), "utf8")), []);
});

test("corrupt queue files are treated as an empty queue", () => {
  mkdirSync(applicationSupportDirectory(), { recursive: true });
  writeFileSync(pendingDispatchesFilePath(), "this is not JSON");

  assert.deepEqual(takePendingDispatches(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
});

test("a missing queue file is treated as an empty queue", () => {
  assert.deepEqual(takePendingDispatches(60_000), {
    pendingDispatches: [],
    droppedStaleCount: 0,
  });
});
