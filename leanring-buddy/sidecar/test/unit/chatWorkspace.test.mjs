import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-chat-ws-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const {
  CHAT_WORKSPACE_ID,
  ensureChatWorkspaceExists,
  clearChatSessionIds,
  listWorkspaces,
  readWorkspaceMetadata,
  updateWorkspaceMetadata,
} = await import("../../src/workspaces.mjs");

test("chat workspace is created hidden with agent notes", () => {
  ensureChatWorkspaceExists();
  assert.equal(CHAT_WORKSPACE_ID, ".chat");
  assert.ok(existsSync(join(sandboxRoot, ".chat", "AGENTS.md")));
  // Dot prefix keeps it out of the topic list and roster.
  assert.equal(listWorkspaces().some((workspace) => workspace.id === ".chat"), false);
});

test("clearChatSessionIds wipes both backends' resume ids", () => {
  updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
    claudeSessionId: "stale-claude",
    codexThreadId: "stale-codex",
  });
  clearChatSessionIds();
  const chatMetadata = readWorkspaceMetadata(CHAT_WORKSPACE_ID);
  assert.equal(chatMetadata.claudeSessionId, null);
  assert.equal(chatMetadata.codexThreadId, null);
});
