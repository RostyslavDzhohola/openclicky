import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCancelTag } from "../../src/cancelTag.mjs";

test("cancel tag parses a topic slug and strips the spoken text", () => {
  const parsed = parseCancelTag("stopping that build. [CANCEL:japanese]");

  assert.equal(parsed.cleanedText, "stopping that build.");
  assert.deepEqual(parsed.cancelRequest, { topicSlug: "japanese" });
});

test("malformed cancel tags are stripped without creating a request", () => {
  const parsed = parseCancelTag("hmm. [CANCEL:] [ CANCEL : japanese : extra ]");

  assert.equal(parsed.cleanedText, "hmm.");
  assert.equal(parsed.cancelRequest, null);
});

test("only the first valid cancel tag wins while every cancel tag is stripped", () => {
  const parsed = parseCancelTag(
    "okay. [CANCEL:japanese] [cancel:french] [CANCEL:]"
  );

  assert.deepEqual(parsed.cancelRequest, { topicSlug: "japanese" });
  assert.equal(parsed.cleanedText.includes("[CANCEL"), false);
  assert.equal(parsed.cleanedText.toLowerCase().includes("[cancel"), false);
});

test("cancel tag rejects an invalid topic slug", () => {
  const parsed = parseCancelTag("not that one. [CANCEL:Japanese lesson]");

  assert.equal(parsed.cleanedText, "not that one.");
  assert.equal(parsed.cancelRequest, null);
});

test("text without a cancel tag is left untouched", () => {
  const responseText = "your japanese lesson is still building.";
  const parsed = parseCancelTag(responseText);

  assert.equal(parsed.cleanedText, responseText);
  assert.equal(parsed.cancelRequest, null);
});
