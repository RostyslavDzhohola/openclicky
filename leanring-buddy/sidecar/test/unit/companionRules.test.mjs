import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPANION_RULES } from "../../src/companionRules.mjs";

test("companion rules define cancellation and ambiguous lesson request routing", () => {
  assert.match(COMPANION_RULES, /\[CANCEL:topic-slug\]/);
  assert.match(COMPANION_RULES, /ambiguous|could mean either/i);
  assert.match(COMPANION_RULES, /clarifying question|open your latest .* lesson, or build/i);
});
