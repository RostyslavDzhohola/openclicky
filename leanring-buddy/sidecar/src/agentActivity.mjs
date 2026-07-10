export function describeClaudeSubagentActivity(sdkMessage) {
  if (sdkMessage?.type !== "assistant" || !sdkMessage.parent_tool_use_id) {
    return null;
  }
  const toolNames = (sdkMessage.message?.content ?? [])
    .filter((contentBlock) => contentBlock?.type === "tool_use" && contentBlock.name)
    .map((contentBlock) => String(contentBlock.name));
  return {
    phase: "subagent",
    tool: "subagent",
    detail: toolNames.length > 0 ? `tools:${toolNames.join(",")}` : "activity",
    parentToolUseId: sdkMessage.parent_tool_use_id,
  };
}

export function codexSubagentCapabilityStatus() {
  return {
    phase: "capability",
    tool: "subagent-identity",
    detail: "unavailable",
  };
}
