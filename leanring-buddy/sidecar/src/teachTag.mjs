// Parser for the extended teach tag the chat agent emits:
//   [TEACH:topic]                      (legacy shape, default instructions)
//   [TEACH:topic:instructions...]     (instructions may contain colons)
//
// The sidecar strips every teach tag from the spoken reply and dispatches at
// most the FIRST well-formed one. A tag with an empty topic is malformed:
// stripped from speech (never read a tag aloud) but not dispatched, per the
// design's error-handling rules.

const TEACH_TAG_PATTERN = /\[TEACH:([^:\][]*)(?::([^\][]*))?\]/gi;

export const DEFAULT_TEACH_INSTRUCTIONS = "start this topic from the basics";

export function parseTeachTag(responseText) {
  let dispatch = null;

  const cleanedText = String(responseText ?? "")
    .replace(TEACH_TAG_PATTERN, (fullMatch, rawTopicText, rawInstructions) => {
      const topicText = (rawTopicText ?? "").trim();
      if (topicText !== "" && dispatch === null) {
        const instructions = (rawInstructions ?? "").trim();
        dispatch = {
          topicText,
          instructions: instructions === "" ? DEFAULT_TEACH_INSTRUCTIONS : instructions,
        };
      }
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { cleanedText, dispatch };
}
