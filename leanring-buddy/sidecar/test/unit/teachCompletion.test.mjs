import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLessonCompletionAnnouncement,
  lessonFileNamesCreatedDuringDispatch,
} from "../../src/teachCompletion.mjs";

test("completion announces a newly created lesson without exposing the agent report", () => {
  assert.deepEqual(
    lessonFileNamesCreatedDuringDispatch({
      lessonFileNamesBeforeDispatch: ["0005-numbers.html", "0006-prices.html"],
      lessonFileNamesAfterDispatch: [
        "0005-numbers.html",
        "0006-prices.html",
        "0007-checkout.html",
      ],
    }),
    ["0007-checkout.html"]
  );
  assert.equal(
    buildLessonCompletionAnnouncement("Japanese"),
    "your Japanese lesson is ready — opening it now."
  );
});

test("no new lesson means there is no new-lesson announcement", () => {
  assert.deepEqual(
    lessonFileNamesCreatedDuringDispatch({
      lessonFileNamesBeforeDispatch: ["0006-prices.html"],
      lessonFileNamesAfterDispatch: ["0006-prices.html"],
    }),
    []
  );
});

test("completion announcement falls back safely when the topic is blank", () => {
  assert.equal(
    buildLessonCompletionAnnouncement("  "),
    "your lesson is ready — opening it now."
  );
});
