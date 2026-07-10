// Learning-workspace management.
//
// Every topic lives in its own folder under the lessons root (default
// ~/Documents/OpenClicky Lessons/). Each folder is a self-contained teach-skill
// workspace: the skill treats cwd as its state store (MISSION.md,
// RESOURCES.md, lessons/, learning-records/, ...), so one folder per topic
// guarantees no cross-topic contamination — and any folder can be opened
// with plain terminal Claude Code or Codex and picked up exactly where
// Clicky left off.
//
// Clicky's own bookkeeping lives in a single hidden file per workspace,
// .clicky.json: {name, slug, createdAt, lastUsedAt, claudeSessionId,
// codexThreadId}. The session ids let both backends resume conversation
// context across sidecar restarts.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPANION_CHAT_NOTES, COMPANION_WORKSPACE_NOTES } from "./companionRules.mjs";
import { emitLog } from "./protocol.mjs";

export const GENERAL_WORKSPACE_ID = "general";
export const CHAT_WORKSPACE_ID = ".chat";

/** Root folder for all workspaces. Overridable for terminal test runs. */
export function lessonsRootDirectory() {
  return (
    process.env.CLICKY_LESSONS_ROOT ?? join(homedir(), "Documents", "OpenClicky Lessons")
  );
}

export function workspacePath(workspaceId) {
  return join(lessonsRootDirectory(), workspaceId);
}

function clickyMetadataPath(workspaceId) {
  return join(workspacePath(workspaceId), ".clicky.json");
}

function syncAgentsFileWithExpectedContent(directoryPath, expectedAgentsFileContent) {
  const agentsFilePath = join(directoryPath, "AGENTS.md");
  const currentAgentsFileContent = existsSync(agentsFilePath)
    ? readFileSync(agentsFilePath, "utf8")
    : null;
  // Heal older workspaces with the fatter persona automatically, and keep
  // Codex workspace notes in lockstep with the code.
  if (currentAgentsFileContent !== expectedAgentsFileContent) {
    writeFileSync(agentsFilePath, expectedAgentsFileContent);
  }
}

export function readWorkspaceMetadata(workspaceId) {
  try {
    return JSON.parse(readFileSync(clickyMetadataPath(workspaceId), "utf8"));
  } catch {
    return null;
  }
}

export function updateWorkspaceMetadata(workspaceId, changes) {
  const existingMetadata = readWorkspaceMetadata(workspaceId) ?? {};
  const updatedMetadata = {
    ...existingMetadata,
    ...changes,
    lastUsedAt: new Date().toISOString(),
  };
  writeFileSync(
    clickyMetadataPath(workspaceId),
    JSON.stringify(updatedMetadata, null, 2) + "\n"
  );
  return updatedMetadata;
}

/** Turns a spoken topic name into a filesystem-safe folder slug. */
export function slugifyTopicName(topicName) {
  const slug = topicName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (slug.length > 0) {
    return slug;
  }
  // Topic names written entirely in non-Latin scripts (Cyrillic, CJK, ...)
  // slug to an empty string. Derive a stable per-name fallback instead of a
  // shared "topic" bucket, so two different topics never merge workspaces.
  const topicNameHash = createHash("sha256").update(topicName).digest("hex").slice(0, 8);
  return `topic-${topicNameHash}`;
}

/**
 * Creates (or returns, if it already exists) a workspace folder for a topic.
 * Writes AGENTS.md so the Codex CLI natively picks up slim companion voice
 * notes (Claude gets the full rules via the system-prompt append instead).
 * The teach skill itself is installed by ensureTeachSkillInstalled().
 */
export function createWorkspace(topicName) {
  const workspaceId =
    topicName === GENERAL_WORKSPACE_ID
      ? GENERAL_WORKSPACE_ID
      : slugifyTopicName(topicName);
  const directoryPath = workspacePath(workspaceId);
  const alreadyExisted = existsSync(directoryPath);

  mkdirSync(directoryPath, { recursive: true });

  const expectedAgentsFileContent = COMPANION_WORKSPACE_NOTES + "\n";
  syncAgentsFileWithExpectedContent(directoryPath, expectedAgentsFileContent);

  if (!alreadyExisted) {
    updateWorkspaceMetadata(workspaceId, {
      name: topicName,
      slug: workspaceId,
      createdAt: new Date().toISOString(),
    });
    emitLog("info", `Created workspace "${workspaceId}" at ${directoryPath}`);
  }

  return describeWorkspace(workspaceId);
}

export function describeWorkspace(workspaceId) {
  const metadata = readWorkspaceMetadata(workspaceId) ?? {};
  const lessonsDirectory = join(workspacePath(workspaceId), "lessons");
  let lessonCount = 0;
  if (existsSync(lessonsDirectory)) {
    lessonCount = readdirSync(lessonsDirectory).filter((fileName) =>
      fileName.endsWith(".html")
    ).length;
  }
  return {
    id: workspaceId,
    name: metadata.name ?? workspaceId,
    path: workspacePath(workspaceId),
    lessonCount,
    createdAt: metadata.createdAt ?? null,
    lastUsedAt: metadata.lastUsedAt ?? null,
  };
}

export function listWorkspaces() {
  const rootDirectory = lessonsRootDirectory();
  if (!existsSync(rootDirectory)) {
    return [];
  }
  return readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => describeWorkspace(entry.name))
    .sort((firstWorkspace, secondWorkspace) => {
      // General first, then most recently used
      if (firstWorkspace.id === GENERAL_WORKSPACE_ID) return -1;
      if (secondWorkspace.id === GENERAL_WORKSPACE_ID) return 1;
      return (secondWorkspace.lastUsedAt ?? "").localeCompare(
        firstWorkspace.lastUsedAt ?? ""
      );
    });
}

export function workspaceExists(workspaceId) {
  return existsSync(workspacePath(workspaceId));
}

/**
 * The ephemeral chat plane lives in a hidden dot-folder under the lessons
 * root: existing session/metadata machinery works on it unchanged, while the
 * dot prefix keeps it out of listWorkspaces(), the roster, and the dashboard.
 * Created directly (not via createWorkspace) because slugifyTopicName would
 * strip the dot.
 */
export function ensureChatWorkspaceExists() {
  const chatDirectoryPath = workspacePath(CHAT_WORKSPACE_ID);
  const chatWorkspaceAlreadyExisted = existsSync(chatDirectoryPath);
  mkdirSync(chatDirectoryPath, { recursive: true });

  const expectedAgentsFileContent = COMPANION_CHAT_NOTES + "\n";
  syncAgentsFileWithExpectedContent(chatDirectoryPath, expectedAgentsFileContent);

  if (!chatWorkspaceAlreadyExisted) {
    updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
      name: "ephemeral chat",
      slug: CHAT_WORKSPACE_ID,
      createdAt: new Date().toISOString(),
    });
  }
}

/** Chat context never survives an app restart (design decision). */
export function clearChatSessionIds() {
  if (!workspaceExists(CHAT_WORKSPACE_ID)) return;
  updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
    claudeSessionId: null,
    codexThreadId: null,
  });
}
