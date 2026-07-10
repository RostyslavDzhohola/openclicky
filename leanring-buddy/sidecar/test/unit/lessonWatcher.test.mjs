import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLessonEventCoordinator,
  didAgentOpenLesson,
} from "../../src/lessonWatcher.mjs";

function createCoordinatorHarness({ gracePeriodMs = 15, holdSafetyTimeoutMs = 50 } = {}) {
  let lastBackendForWorkspace = "claude";
  const shellCommandsByBackend = new Map([
    ["claude", []],
    ["codex", []],
  ]);
  const requestedShellCommandBackends = [];
  const emittedLessonEvents = [];
  const logs = [];
  let dashboardRegenerationCount = 0;
  const coordinator = createLessonEventCoordinator({
    gracePeriodMs,
    holdSafetyTimeoutMs,
    getShellCommandsForWorkspace: (workspaceId, heldLessonBackend) => {
      const commandBackend = heldLessonBackend ?? lastBackendForWorkspace;
      requestedShellCommandBackends.push(commandBackend);
      return shellCommandsByBackend.get(commandBackend) ?? [];
    },
    regenerateDashboard: () => {
      dashboardRegenerationCount += 1;
    },
    emitLessonCreatedEvent: (lessonEvent) => {
      emittedLessonEvents.push(lessonEvent);
    },
    emitLog: (level, message) => {
      logs.push({ level, message });
    },
  });

  return {
    coordinator,
    emittedLessonEvents,
    logs,
    requestedShellCommandBackends,
    get dashboardRegenerationCount() {
      return dashboardRegenerationCount;
    },
    setLastBackendForWorkspace(backend) {
      lastBackendForWorkspace = backend;
    },
    setShellCommands(commands, backend = lastBackendForWorkspace) {
      shellCommandsByBackend.set(backend, commands);
    },
  };
}

function waitForTimer(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("didAgentOpenLesson requires open to be the shell segment command", () => {
  assert.equal(
    didAgentOpenLesson(["open lessons/0001-x.html"], "0001-x.html"),
    true
  );
  assert.equal(
    didAgentOpenLesson(["cd foo && open \"lessons/0002-y.html\""], "0002-y.html"),
    true
  );
  assert.equal(
    didAgentOpenLesson(
      ["CLICKY_SOURCE=agent open lessons/0002-y.html"],
      "0002-y.html"
    ),
    true
  );
  assert.equal(
    didAgentOpenLesson(
      ["echo hi > lessons/0001-open-source.html"],
      "0001-open-source.html"
    ),
    false
  );
  assert.equal(
    didAgentOpenLesson(["reopen lessons/0003-z.html"], "0003-z.html"),
    false
  );
});

test("unheld lesson additions use commands available when the grace period ends", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.setShellCommands(["open /lessons/css/lessons/0001-selectors.html"]);
  await waitForTimer(30);

  assert.deepEqual(harness.emittedLessonEvents, [
    {
      type: "lessonCreated",
      workspaceId: "css",
      path: "/lessons/css/lessons/0001-selectors.html",
      openedByAgent: true,
    },
  ]);
  assert.equal(harness.dashboardRegenerationCount, 1);
  assert.match(harness.logs[0].message, /held=false/);
});

test("held lessons use commands recorded after the add and before the turn flushes", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude", {
    traceId: "trace-1",
    parentTurnId: "turn-1",
    dispatchId: "dispatch-1",
  });
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.setShellCommands(["open /lessons/css/lessons/0001-selectors.html"]);
  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents.length, 1);
  assert.equal(harness.emittedLessonEvents[0].openedByAgent, true);
  assert.equal(harness.emittedLessonEvents[0].traceId, "trace-1");
  assert.equal(harness.emittedLessonEvents[0].parentTurnId, "turn-1");
  assert.equal(harness.emittedLessonEvents[0].dispatchId, "dispatch-1");
  assert.match(harness.logs[0].message, /held=true/);
});

test("held lessons use the backend captured when the hold began", () => {
  const harness = createCoordinatorHarness();
  harness.setShellCommands(
    ["open /lessons/css/lessons/0001-selectors.html"],
    "claude"
  );
  harness.setShellCommands([], "codex");
  harness.setLastBackendForWorkspace("claude");
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.setLastBackendForWorkspace("codex");
  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents[0].openedByAgent, true);
  assert.deepEqual(harness.requestedShellCommandBackends, ["claude"]);
});

test("held lessons flush as unopened when the turn did not open them", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents.length, 1);
  assert.equal(harness.emittedLessonEvents[0].openedByAgent, false);
});

test("overlapping teach holds do not flush until every holder ends", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css");
  assert.equal(harness.emittedLessonEvents.length, 0);

  harness.coordinator.endTeachTurnHold("css");
  assert.equal(harness.emittedLessonEvents.length, 1);
});

test("a stranded teach hold safety-flushes queued lessons", async () => {
  const harness = createCoordinatorHarness({ holdSafetyTimeoutMs: 15 });
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  await waitForTimer(30);

  assert.equal(harness.emittedLessonEvents.length, 1);
  assert.equal(harness.emittedLessonEvents[0].openedByAgent, false);
  assert.equal(harness.logs.some((log) => log.level === "warn"), true);
});

test("one hold flushes multiple queued lessons in discovery order", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0002-layout.html",
  });
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0003-animation.html",
  });

  harness.coordinator.endTeachTurnHold("css");

  assert.deepEqual(
    harness.emittedLessonEvents.map((lessonEvent) => lessonEvent.path),
    [
      "/lessons/css/lessons/0001-selectors.html",
      "/lessons/css/lessons/0002-layout.html",
      "/lessons/css/lessons/0003-animation.html",
    ]
  );
});

test("discarding a sole hold drops queued lessons without emitting them", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css", { discardQueuedLessons: true });

  assert.equal(harness.emittedLessonEvents.length, 0);
  assert.equal(harness.dashboardRegenerationCount, 0);
  assert.equal(
    harness.logs.some(
      (log) => log.level === "info" && /dropping 1 queued lesson/i.test(log.message)
    ),
    true
  );
});

test("a discard request on one nested hold prevents the final hold from flushing", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css", { discardQueuedLessons: true });
  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents.length, 0);
  assert.equal(harness.dashboardRegenerationCount, 0);
});

test("a marked nested hold discards queued lessons at the safety timeout", async () => {
  const harness = createCoordinatorHarness({ holdSafetyTimeoutMs: 15 });
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css", { discardQueuedLessons: true });
  await waitForTimer(30);

  assert.equal(harness.emittedLessonEvents.length, 0);
  assert.equal(harness.dashboardRegenerationCount, 0);
  assert.equal(
    harness.logs.some(
      (log) => log.level === "info" && /dropping 1 queued lesson/i.test(log.message)
    ),
    true
  );
});

test("ending a hold without discard keeps the default flush behavior", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css", "claude");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents.length, 1);
  assert.equal(harness.dashboardRegenerationCount, 1);
});
