import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codexSubagentCapabilityStatus,
  describeClaudeSubagentActivity,
} from "../../src/agentActivity.mjs";

test("Claude sub-agent activity exposes metadata without assistant prose", () => {
  const activity = describeClaudeSubagentActivity({
    type: "assistant",
    parent_tool_use_id: "tool-parent-1",
    message: {
      content: [
        { type: "text", text: "private model output" },
        { type: "tool_use", name: "WebSearch", input: { query: "private query" } },
      ],
    },
  });

  assert.deepEqual(activity, {
    phase: "subagent",
    tool: "subagent",
    detail: "tools:WebSearch",
    parentToolUseId: "tool-parent-1",
  });
  assert.doesNotMatch(JSON.stringify(activity), /private model output/);
  assert.doesNotMatch(JSON.stringify(activity), /private query/);
});

test("top-level Claude messages are not mislabeled as sub-agent activity", () => {
  assert.equal(
    describeClaudeSubagentActivity({ type: "assistant", message: { content: [] } }),
    null
  );
});

test("Codex reports that distinct sub-agent identity is unavailable", () => {
  assert.deepEqual(codexSubagentCapabilityStatus(), {
    phase: "capability",
    tool: "subagent-identity",
    detail: "unavailable",
  });
});
