import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeachTag } from "../../src/teachTag.mjs";

test("extended tag with instructions is parsed and stripped", () => {
  const parsed = parseTeachTag(
    "on it — adding that to your japanese lessons. [TEACH:japanese:build the anime phrases on screen into the next lesson]"
  );
  assert.equal(parsed.cleanedText, "on it — adding that to your japanese lessons.");
  assert.deepEqual(parsed.dispatch, {
    topicText: "japanese",
    instructions: "build the anime phrases on screen into the next lesson",
  });
});

test("legacy tag without instructions gets the default instruction", () => {
  const parsed = parseTeachTag("let's learn flexbox! [TEACH:css flexbox]");
  assert.equal(parsed.cleanedText, "let's learn flexbox!");
  assert.deepEqual(parsed.dispatch, {
    topicText: "css flexbox",
    instructions: "start this topic from the basics",
  });
});

test("instructions may contain colons", () => {
  const parsed = parseTeachTag("sure. [TEACH:git:cover rebase: interactive mode and conflicts]");
  assert.equal(parsed.dispatch.topicText, "git");
  assert.equal(parsed.dispatch.instructions, "cover rebase: interactive mode and conflicts");
});

test("no tag means no dispatch and untouched text", () => {
  const parsed = parseTeachTag("html is the skeleton of every web page.");
  assert.equal(parsed.cleanedText, "html is the skeleton of every web page.");
  assert.equal(parsed.dispatch, null);
});

test("malformed tag (empty topic) is stripped but not dispatched", () => {
  const parsed = parseTeachTag("hmm. [TEACH:]");
  assert.equal(parsed.cleanedText, "hmm.");
  assert.equal(parsed.dispatch, null);
});

test("only the first valid tag dispatches; all tags are stripped from speech", () => {
  const parsed = parseTeachTag("okay! [TEACH:japanese:lesson one] [TEACH:french:lesson one]");
  assert.equal(parsed.dispatch.topicText, "japanese");
  assert.equal(parsed.cleanedText.includes("[TEACH"), false);
});

test("point tag is left alone for the app to parse", () => {
  const parsed = parseTeachTag("click the gear icon. [POINT:100,42:settings]");
  assert.equal(parsed.cleanedText, "click the gear icon. [POINT:100,42:settings]");
  assert.equal(parsed.dispatch, null);
});
