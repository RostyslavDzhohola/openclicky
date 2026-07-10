// Parser for the lesson-build cancellation tag the chat agent emits. The
// deterministic sidecar owns cancellation so protocol tags are never spoken.

const CANCEL_TAG_PATTERN = /\[\s*CANCEL\s*:\s*([^\[\]]*)\]/gi;
const TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Strips every CANCEL tag from text and returns only the first valid request.
 * Malformed tags are still removed so an accidental protocol tag is never
 * spoken aloud by the companion.
 */
export function parseCancelTag(responseText) {
  let cancelRequest = null;

  const cleanedText = String(responseText ?? "")
    .replace(CANCEL_TAG_PATTERN, (fullMatch, rawTopicSlug) => {
      const topicSlug = (rawTopicSlug ?? "").trim();
      if (cancelRequest === null && TOPIC_SLUG_PATTERN.test(topicSlug)) {
        cancelRequest = { topicSlug };
      }
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { cleanedText, cancelRequest };
}
