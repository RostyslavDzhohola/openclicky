import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILD_HANDOFF_SPOKEN_NOTE,
  INTERVIEW_PREAMBLE,
  INTERVIEW_TURN_CAP,
  INTERVIEW_WRAP_UP_NOTE,
  LESSON_GROUNDING_NOTE,
  POST_INTERVIEW_BUILD_INSTRUCTIONS,
  createInterviewTracker,
  missionFileExists,
} from "../../src/teachInterview.mjs";

test("interview tracker starts without an active interview", () => {
  const interviewTracker = createInterviewTracker();

  assert.equal(interviewTracker.activeInterview, null);
});

test("begin creates an interview and replaces any previous interview", () => {
  const interviewTracker = createInterviewTracker();
  const firstInterview = interviewTracker.begin({
    workspaceId: "first-topic",
    backend: "claude",
    model: "sonnet",
    topicText: "First Topic",
    lessonCountAtInterviewStart: 3,
  });
  const replacementInterview = interviewTracker.begin({
    workspaceId: "replacement-topic",
    backend: "codex",
    model: "gpt-5",
    topicText: "Replacement Topic",
  });

  assert.deepEqual(firstInterview, {
    workspaceId: "first-topic",
    backend: "claude",
    model: "sonnet",
    topicText: "First Topic",
    lessonCountAtInterviewStart: 3,
    turnCount: 0,
  });
  assert.deepEqual(replacementInterview, {
    workspaceId: "replacement-topic",
    backend: "codex",
    model: "gpt-5",
    topicText: "Replacement Topic",
    lessonCountAtInterviewStart: 0,
    turnCount: 0,
  });
  assert.equal(interviewTracker.activeInterview, replacementInterview);
});

test("recordRoutedTurn counts turns and reports the interview cap", () => {
  const interviewTracker = createInterviewTracker();
  interviewTracker.begin({
    workspaceId: "topic",
    backend: "claude",
    model: "sonnet",
    topicText: "Topic",
  });

  for (let expectedTurnNumber = 1; expectedTurnNumber < INTERVIEW_TURN_CAP; expectedTurnNumber += 1) {
    assert.deepEqual(interviewTracker.recordRoutedTurn(), {
      turnNumber: expectedTurnNumber,
      reachedTurnCap: false,
    });
  }

  assert.deepEqual(interviewTracker.recordRoutedTurn(), {
    turnNumber: INTERVIEW_TURN_CAP,
    reachedTurnCap: true,
  });
  assert.deepEqual(interviewTracker.recordRoutedTurn(), {
    turnNumber: INTERVIEW_TURN_CAP + 1,
    reachedTurnCap: true,
  });
});

test("recordRoutedTurn rejects calls without an active interview", () => {
  const interviewTracker = createInterviewTracker();

  assert.throws(() => interviewTracker.recordRoutedTurn(), new Error("no active interview"));
});

test("complete clears and returns the active interview", () => {
  const interviewTracker = createInterviewTracker();
  const activeInterview = interviewTracker.begin({
    workspaceId: "topic",
    backend: "claude",
    model: "sonnet",
    topicText: "Topic",
  });

  assert.equal(interviewTracker.complete(), activeInterview);
  assert.equal(interviewTracker.activeInterview, null);
  assert.equal(interviewTracker.complete(), null);
});

test("expire clears and returns the active interview", () => {
  const interviewTracker = createInterviewTracker();
  const activeInterview = interviewTracker.begin({
    workspaceId: "topic",
    backend: "claude",
    model: "sonnet",
    topicText: "Topic",
  });

  assert.equal(interviewTracker.expire(), activeInterview);
  assert.equal(interviewTracker.activeInterview, null);
  assert.equal(interviewTracker.expire(), null);
});

test("missionFileExists detects MISSION.md in a workspace", () => {
  const workspaceDirectoryPath = mkdtempSync(join(tmpdir(), "clicky-teach-interview-test-"));

  assert.equal(missionFileExists(workspaceDirectoryPath), false);

  writeFileSync(join(workspaceDirectoryPath, "MISSION.md"), "# Mission\n");

  assert.equal(missionFileExists(workspaceDirectoryPath), true);
});

test("interview constants are populated with the required mission guidance", () => {
  const interviewConstants = [
    INTERVIEW_PREAMBLE,
    LESSON_GROUNDING_NOTE,
    POST_INTERVIEW_BUILD_INSTRUCTIONS,
    INTERVIEW_WRAP_UP_NOTE,
  ];

  for (const interviewConstant of interviewConstants) {
    assert.notEqual(interviewConstant, "");
  }

  assert.match(INTERVIEW_PREAMBLE, /MISSION\.md/);
  assert.match(POST_INTERVIEW_BUILD_INSTRUCTIONS, /MISSION\.md/);
  assert.equal(INTERVIEW_TURN_CAP, 8);
});

test("build handoff spoken note is populated and preserves its leading space", () => {
  assert.notEqual(BUILD_HANDOFF_SPOKEN_NOTE, "");
  assert.equal(BUILD_HANDOFF_SPOKEN_NOTE.startsWith(" "), true);
});
