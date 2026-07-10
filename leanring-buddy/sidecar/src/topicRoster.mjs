// Per-turn topic roster injection (chat plane).
//
// Every ephemeral chat turn carries a compact, freshly-read roster of the
// lesson topics on disk. This is the chat agent's only memory of what topics
// exist, so it can never dispatch to an imagined folder. The rules in
// companionRules.mjs tell the agent the roster is system context (never read
// aloud) and that unknown topics require a spoken confirmation first.

import { GENERAL_WORKSPACE_ID, listWorkspaces } from "./workspaces.mjs";

export function buildTopicRosterText() {
  const topics = listWorkspaces().filter(
    (workspace) => workspace.id !== GENERAL_WORKSPACE_ID
  );

  if (topics.length === 0) {
    return "[topic roster]\n(no lesson topics exist yet)\n[end roster]";
  }

  const rosterLines = topics.map((workspace) => {
    const lessonLabel = workspace.lessonCount === 1 ? "1 lesson" : `${workspace.lessonCount} lessons`;
    const lastUsedLabel = workspace.lastUsedAt ? `last used ${workspace.lastUsedAt.slice(0, 10)}` : "never used";
    return `- ${workspace.name} (slug: ${workspace.id}) — ${lessonLabel}, ${lastUsedLabel}`;
  });

  return `[topic roster]\n${rosterLines.join("\n")}\n[end roster]`;
}

export function composeChatTurnText(transcript, rosterText) {
  return `${transcript}\n\n${rosterText}`;
}
