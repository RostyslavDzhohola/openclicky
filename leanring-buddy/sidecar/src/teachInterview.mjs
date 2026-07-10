// Interview mode lets the unmodified teach skill behave as it would in a real
// CLI: it interviews the user about their mission before building any lesson.
// The skill writing MISSION.md is the deterministic interview-complete signal.
// State stays in memory on purpose: after a sidecar restart, the next teach
// request for a mission-less topic safely re-enters the interview.

import { existsSync } from "node:fs";
import { join } from "node:path";

export const INTERVIEW_TURN_CAP = 8;

export const INTERVIEW_PREAMBLE = `you are talking with the user over voice — every reply you write is spoken aloud, so keep replies short and conversational.

MISSION.md has not been written for this topic yet. before anything else, follow your teach skill's mission instructions: interview the user about why they want to learn this, one question at a time, until the mission is clear. do not create any lesson during this conversation. when the mission is clear, write MISSION.md and tell the user their course is set up — the first lesson will be dispatched separately right after, so do not build it yourself.`;

export const LESSON_GROUNDING_NOTE =
  "\n\nbefore writing the lesson, use web search to ground your understanding of this topic in current, accurate information — verify key facts and examples rather than relying on memory." +
  "\n\nin any quiz, randomize which option position holds the correct answer, and keep all options the same length and word count so formatting gives no clues.";

export const POST_INTERVIEW_BUILD_INSTRUCTIONS = `the mission interview is complete and MISSION.md is written. the user cannot answer questions from here — do not ask anything; rely on MISSION.md for what they want. build the first lesson now.`;

export const INTERVIEW_WRAP_UP_NOTE = `\n\n(system note: this mission interview has reached its turn limit — wrap up now. write MISSION.md with what you already know and stop asking questions.)`;

export const BUILD_HANDOFF_SPOKEN_NOTE = ` your first lesson is on its way — it takes a few minutes and will open on its own, so feel free to do something else.`;

/** True when the teach skill has already captured the topic's mission. */
export function missionFileExists(workspaceDirectoryPath) {
  return existsSync(join(workspaceDirectoryPath, "MISSION.md"));
}

export function createInterviewTracker() {
  let activeInterview = null;

  return {
    get activeInterview() {
      return activeInterview;
    },

    begin({ workspaceId, backend, model, topicText, lessonCountAtInterviewStart }) {
      activeInterview = {
        workspaceId,
        backend,
        model,
        topicText,
        lessonCountAtInterviewStart: lessonCountAtInterviewStart ?? 0,
        turnCount: 0,
      };
      return activeInterview;
    },

    recordRoutedTurn() {
      if (activeInterview === null) {
        throw new Error("no active interview");
      }

      activeInterview.turnCount += 1;
      return {
        turnNumber: activeInterview.turnCount,
        reachedTurnCap: activeInterview.turnCount >= INTERVIEW_TURN_CAP,
      };
    },

    complete() {
      const completedInterview = activeInterview;
      activeInterview = null;
      return completedInterview;
    },

    expire() {
      const expiredInterview = activeInterview;
      activeInterview = null;
      return expiredInterview;
    },
  };
}
