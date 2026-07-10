import { test } from "node:test";
import assert from "node:assert/strict";

import { createLessonEventCoordinator } from "../../src/lessonWatcher.mjs";

function createCoordinatorHarness({ gracePeriodMs = 15, holdSafetyTimeoutMs = 50 } = {}) {
  let shellCommands = [];
  const emittedLessonEvents = [];
  const logs = [];
  let dashboardRegenerationCount = 0;
  const coordinator = createLessonEventCoordinator({
    gracePeriodMs,
    holdSafetyTimeoutMs,
    getShellCommandsForWorkspace: () => shellCommands,
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
    get dashboardRegenerationCount() {
      return dashboardRegenerationCount;
    },
    setShellCommands(commands) {
      shellCommands = commands;
    },
  };
}

function waitForTimer(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  harness.coordinator.beginTeachTurnHold("css");
  harness.coordinator.handleStabilizedLessonAdd({
    workspaceId: "css",
    addedFilePath: "/lessons/css/lessons/0001-selectors.html",
  });

  harness.setShellCommands(["open /lessons/css/lessons/0001-selectors.html"]);
  harness.coordinator.endTeachTurnHold("css");

  assert.equal(harness.emittedLessonEvents.length, 1);
  assert.equal(harness.emittedLessonEvents[0].openedByAgent, true);
  assert.match(harness.logs[0].message, /held=true/);
});

test("held lessons flush as unopened when the turn did not open them", () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.beginTeachTurnHold("css");
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
  harness.coordinator.beginTeachTurnHold("css");
  harness.coordinator.beginTeachTurnHold("css");
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
  harness.coordinator.beginTeachTurnHold("css");
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
  harness.coordinator.beginTeachTurnHold("css");
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
