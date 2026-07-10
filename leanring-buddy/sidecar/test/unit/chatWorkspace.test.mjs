import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-chat-ws-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const {
  CHAT_WORKSPACE_ID,
  createWorkspace,
  ensureChatWorkspaceExists,
  clearChatSessionIds,
  listWorkspaces,
  readWorkspaceMetadata,
  updateWorkspaceMetadata,
} = await import("../../src/workspaces.mjs");
const { COMPANION_CHAT_NOTES, COMPANION_WORKSPACE_NOTES } = await import(
  "../../src/companionRules.mjs"
);

test("chat workspace is created hidden with agent notes", () => {
  ensureChatWorkspaceExists();
  assert.equal(CHAT_WORKSPACE_ID, ".chat");
  assert.ok(existsSync(join(sandboxRoot, ".chat", "AGENTS.md")));
  // Dot prefix keeps it out of the topic list and roster.
  assert.equal(listWorkspaces().some((workspace) => workspace.id === ".chat"), false);
});

test("chat workspace agent notes are healed when stale", () => {
  const agentsFilePath = join(sandboxRoot, ".chat", "AGENTS.md");
  writeFileSync(agentsFilePath, "stale chat notes\n");

  ensureChatWorkspaceExists();

  assert.equal(readFileSync(agentsFilePath, "utf8"), COMPANION_CHAT_NOTES + "\n");
});

test("topic workspace agent notes are healed when stale", () => {
  const workspace = createWorkspace("Stale Topic");
  const agentsFilePath = join(workspace.path, "AGENTS.md");
  writeFileSync(agentsFilePath, "stale topic notes\n");

  createWorkspace("Stale Topic");

  assert.equal(readFileSync(agentsFilePath, "utf8"), COMPANION_WORKSPACE_NOTES + "\n");
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
