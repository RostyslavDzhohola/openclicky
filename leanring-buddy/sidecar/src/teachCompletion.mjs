/** Returns lesson files that did not exist when the background dispatch began. */
export function lessonFileNamesCreatedDuringDispatch({
  lessonFileNamesBeforeDispatch,
  lessonFileNamesAfterDispatch,
}) {
  const lessonFileNamesBeforeDispatchSet = new Set(lessonFileNamesBeforeDispatch);
  return lessonFileNamesAfterDispatch.filter(
    (lessonFileName) => !lessonFileNamesBeforeDispatchSet.has(lessonFileName)
  );
}

/** User-facing completion copy is deterministic; the agent's report stays diagnostic-only. */
export function buildLessonCompletionAnnouncement(topicText) {
  const normalizedTopicText = String(topicText ?? "").trim();
  const topicDescription = normalizedTopicText.length > 0 ? ` ${normalizedTopicText}` : "";
  return `your${topicDescription} lesson is ready — opening it now.`;
}
