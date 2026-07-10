import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPANION_RULES } from "../../src/companionRules.mjs";

test("companion rules define cancellation and ambiguous lesson request routing", () => {
  assert.match(COMPANION_RULES, /\[CANCEL:topic-slug\]/);
  assert.match(COMPANION_RULES, /ambiguous|could mean either/i);
  assert.match(COMPANION_RULES, /clarifying question|open your latest .* lesson, or build/i);
});

test("learning-routing examples include the required point protocol tag", () => {
  assert.match(
    COMPANION_RULES,
    /teach me japanese[^\n]+\[POINT:none\] \[TEACH:japanese:/
  );
  assert.match(
    COMPANION_RULES,
    /add this to my next lesson[^\n]+\[POINT:none\] \[TEACH:japanese:/
  );
  assert.match(
    COMPANION_RULES,
    /yes, start it[^\n]+\[POINT:none\] \[TEACH:rust:/
  );
  assert.match(
    COMPANION_RULES,
    /i didn't ask for a new lesson[^\n]+\[POINT:none\] \[CANCEL:japanese\]\[OPEN:japanese\]/
  );
});
