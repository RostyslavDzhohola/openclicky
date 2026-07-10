// Parser and resolver for the lightweight lesson-opening tag the chat agent
// emits. Keeping filesystem resolution here makes the deterministic portion
// unit-testable without spawning macOS's `open` command.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OPEN_TAG_PATTERN = /\[\s*OPEN\s*:\s*([^\[\]]*)\]/gi;
const TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LESSON_FILE_NAME_PATTERN = /^(\d{4})-.*\.html$/i;

function normalizeLessonOrdinal(rawOrdinalText) {
  const ordinalText = rawOrdinalText.trim();
  if (!/^\d{1,4}$/.test(ordinalText)) return null;
  return ordinalText.padStart(4, "0");
}

/**
 * Strips every OPEN tag from text and returns only the first valid request.
 * Malformed tags are still removed so an accidental protocol tag is never
 * spoken aloud by the companion.
 */
export function parseOpenTag(responseText) {
  let openRequest = null;

  const cleanedText = String(responseText ?? "")
    .replace(OPEN_TAG_PATTERN, (fullMatch, rawTagContents) => {
      const tagParts = rawTagContents.split(":");
      const topicSlug = (tagParts[0] ?? "").trim();
      const hasNoOrdinal = tagParts.length === 1;
      const hasOneOrdinal = tagParts.length === 2;
      const lessonOrdinal = hasOneOrdinal ? normalizeLessonOrdinal(tagParts[1]) : null;

      const hasValidOrdinal = hasNoOrdinal || lessonOrdinal !== null;
      if (
        openRequest === null &&
        hasValidOrdinal &&
        TOPIC_SLUG_PATTERN.test(topicSlug)
      ) {
        openRequest = { topicSlug, lessonOrdinal };
      }
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { cleanedText, openRequest };
}

/**
 * Finds the requested lesson by its filename ordinal, never filesystem mtime.
 * The agent only names roster slugs, but this validator also keeps the helper
 * safe when it is called directly from tests or future protocol handlers.
 */
export function resolveOpenLessonPath({ lessonsRootDirectory, topicSlug, lessonOrdinal }) {
  if (!TOPIC_SLUG_PATTERN.test(topicSlug ?? "")) {
    return { lessonPath: null, failureReason: "invalid_slug" };
  }

  const topicWorkspaceDirectory = join(lessonsRootDirectory, topicSlug);
  if (!existsSync(topicWorkspaceDirectory)) {
    return { lessonPath: null, failureReason: "unknown_slug" };
  }

  const lessonsDirectory = join(topicWorkspaceDirectory, "lessons");
  if (!existsSync(lessonsDirectory)) {
    return { lessonPath: null, failureReason: "no_lessons" };
  }

  let lessonFiles;
  try {
    lessonFiles = readdirSync(lessonsDirectory)
      .map((fileName) => {
        const match = fileName.match(LESSON_FILE_NAME_PATTERN);
        return match ? { fileName, ordinal: match[1] } : null;
      })
      .filter(Boolean);
  } catch {
    return { lessonPath: null, failureReason: "lessons_directory_unreadable" };
  }

  if (lessonFiles.length === 0) {
    return { lessonPath: null, failureReason: "no_lessons" };
  }

  if (lessonOrdinal) {
    const requestedLesson = lessonFiles.find((lessonFile) => lessonFile.ordinal === lessonOrdinal);
    return requestedLesson
      ? { lessonPath: join(lessonsDirectory, requestedLesson.fileName), failureReason: null }
      : { lessonPath: null, failureReason: "ordinal_not_found" };
  }

  lessonFiles.sort((firstLesson, secondLesson) =>
    secondLesson.ordinal.localeCompare(firstLesson.ordinal)
  );
  return {
    lessonPath: join(lessonsDirectory, lessonFiles[0].fileName),
    failureReason: null,
  };
}
