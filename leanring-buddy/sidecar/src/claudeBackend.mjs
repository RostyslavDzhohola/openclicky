// Claude backend: one persistent Claude Agent SDK session per workspace.
//
// Each workspace gets a long-lived streaming-input query() session whose cwd
// is the workspace folder, so the teach skill's file state and the
// conversation context both live exactly where a vanilla Claude Code session
// would keep them. Session ids are persisted to the workspace's .clicky.json
// after every turn so a sidecar restart resumes the same conversation.
//
// Auth: subscription login by default. src/env.mjs guarantees
// ANTHROPIC_API_KEY is only present when the user explicitly opted into
// API-key billing, so the spawned Claude Code runtime falls back to the
// user's own `claude` CLI OAuth credentials.

import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { COMPANION_RULES } from "./companionRules.mjs";
import { emitLog } from "./protocol.mjs";
import {
  readWorkspaceMetadata,
  updateWorkspaceMetadata,
  workspacePath,
} from "./workspaces.mjs";

/** Maps the app's model ids to Agent SDK model aliases. */
function resolveClaudeModelAlias(requestedModel) {
  if (!requestedModel) return "sonnet";
  if (requestedModel.includes("opus")) return "opus";
  if (requestedModel.includes("sonnet")) return "sonnet";
  return requestedModel;
}

function resolveClaudeEffortLevel(requestedEffort) {
  const effortLevel = String(requestedEffort ?? "").trim().toLowerCase();
  if (["low", "medium", "high", "max"].includes(effortLevel)) {
    return effortLevel;
  }
  return null;
}

function detectImageMediaType(imageFilePath) {
  return imageFilePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * Builds the Anthropic content blocks for one user turn: each screenshot as
 * a base64 image block followed by its label, then the spoken transcript.
 * Mirrors the block order the original ClaudeAPI.swift used.
 */
function buildUserContentBlocks(text, images) {
  const contentBlocks = [];
  for (const image of images ?? []) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: detectImageMediaType(image.path),
        data: readFileSync(image.path).toString("base64"),
      },
    });
    if (image.label) {
      contentBlocks.push({ type: "text", text: image.label });
    }
  }
  contentBlocks.push({ type: "text", text });
  return contentBlocks;
}

/** Summarizes a tool_use input into a short human-readable detail string. */
function describeToolUse(toolName, toolInput) {
  let detail = "";
  if (toolInput && typeof toolInput === "object") {
    detail =
      toolInput.command ??
      toolInput.file_path ??
      toolInput.url ??
      toolInput.skill ??
      toolInput.pattern ??
      "";
    if (typeof detail !== "string") detail = "";
    if (detail === "") {
      detail = JSON.stringify(toolInput);
    }
  }
  return detail.length > 160 ? detail.slice(0, 160) + "…" : detail;
}

/**
 * An unbounded push queue exposed as the AsyncIterable the Agent SDK
 * consumes for streaming input. Ending it closes the session's stdin.
 */
class PushableMessageStream {
  constructor() {
    this.queuedMessages = [];
    this.wakeUpWaiter = null;
    this.isEnded = false;
  }

  push(message) {
    this.queuedMessages.push(message);
    this.wakeUpWaiter?.();
    this.wakeUpWaiter = null;
  }

  end() {
    this.isEnded = true;
    this.wakeUpWaiter?.();
    this.wakeUpWaiter = null;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queuedMessages.length === 0) {
        if (this.isEnded) return;
        await new Promise((resolve) => {
          this.wakeUpWaiter = resolve;
        });
      }
      yield this.queuedMessages.shift();
    }
  }
}

class ClaudeWorkspaceSession {
  constructor(workspaceId, modelAlias, effortLevel) {
    this.workspaceId = workspaceId;
    this.modelAlias = modelAlias;
    this.effortLevel = effortLevel;
    this.inputStream = new PushableMessageStream();
    this.currentTurn = null; // {resolve, reject, onStatus, requestId, sawToolUse, bashCommands}
    this.turnChain = Promise.resolve(); // serializes turns within one workspace
    this.isDead = false;
    this.sessionId = readWorkspaceMetadata(workspaceId)?.claudeSessionId ?? null;
    this.lastTurnBashCommands = [];

    const options = {
      cwd: workspacePath(workspaceId),
      model: modelAlias,
      systemPrompt: { type: "preset", preset: "claude_code", append: COMPANION_RULES },
      // Project-only: sessions must load ONLY the config the app ships into the
      // workspace (.claude/skills/teach etc.). Including "user" here would pull
      // in the user's personal ~/.claude hooks, skills, output styles, and
      // plugins, making the lesson agent behave differently per machine.
      settingSources: ["project"],
      skills: "all",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    if (effortLevel) {
      options.effort = effortLevel;
    }
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    this.queryHandle = query({ prompt: this.inputStream, options });
    this.readerLoopPromise = this.runReaderLoop();
  }

  /** Consumes every SDK message for the session's lifetime, routing to the active turn. */
  async runReaderLoop() {
    try {
      for await (const sdkMessage of this.queryHandle) {
        this.handleSDKMessage(sdkMessage);
      }
      this.markDead(new Error("Claude session ended unexpectedly"));
    } catch (readerError) {
      this.markDead(readerError);
    }
  }

  handleSDKMessage(sdkMessage) {
    if (sdkMessage.session_id && sdkMessage.session_id !== this.sessionId) {
      this.sessionId = sdkMessage.session_id;
      updateWorkspaceMetadata(this.workspaceId, { claudeSessionId: this.sessionId });
    }

    const activeTurn = this.currentTurn;

    if (sdkMessage.type === "assistant") {
      if (sdkMessage.error === "authentication_failed" || sdkMessage.error === "oauth_org_not_allowed") {
        activeTurn?.reject(makeBackendError("auth_required", "claude login expired or missing — run `claude` in terminal and sign in"));
        return;
      }
      // Ignore subagent traffic; only surface top-level tool activity
      if (sdkMessage.parent_tool_use_id) return;
      const contentBlocks = sdkMessage.message?.content ?? [];
      for (const block of contentBlocks) {
        if (block.type === "tool_use" && activeTurn) {
          activeTurn.sawToolUse = true;
          if (block.name === "Bash" && typeof block.input?.command === "string") {
            activeTurn.bashCommands.push(block.input.command);
          }
          activeTurn.onStatus?.({
            phase: "tool",
            tool: block.name,
            detail: describeToolUse(block.name, block.input),
          });
        }
      }
      return;
    }

    if (sdkMessage.type === "result") {
      if (!activeTurn) return;
      this.currentTurn = null;
      this.lastTurnBashCommands = activeTurn.bashCommands;
      if (sdkMessage.subtype === "success" && !sdkMessage.is_error) {
        activeTurn.resolve({
          text: sdkMessage.result ?? "",
          sessionId: this.sessionId,
          durationMs: sdkMessage.duration_ms,
          sawToolUse: activeTurn.sawToolUse,
        });
      } else {
        const resultText = sdkMessage.result ?? sdkMessage.subtype ?? "unknown error";
        const isAuthProblem = /credential|login|authent|api key|oauth/i.test(resultText);
        activeTurn.reject(
          makeBackendError(isAuthProblem ? "auth_required" : "internal", resultText)
        );
      }
    }
  }

  markDead(cause) {
    if (this.isDead) return;
    this.isDead = true;
    const failure = makeBackendError(
      "node_backend_crash",
      `claude session died: ${cause?.message ?? cause}`
    );
    this.currentTurn?.reject(failure);
    this.currentTurn = null;
  }

  /** Runs one user turn; turns are serialized per workspace via turnChain. */
  runTurn(requestId, text, images, onStatus) {
    const turnExecution = this.turnChain.then(() => {
      if (this.isDead) {
        throw makeBackendError("node_backend_crash", "claude session is no longer running");
      }
      return new Promise((resolve, reject) => {
        this.currentTurn = {
          requestId,
          resolve,
          reject,
          onStatus,
          sawToolUse: false,
          bashCommands: [],
        };
        onStatus?.({ phase: "thinking" });
        this.inputStream.push({
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: buildUserContentBlocks(text, images) },
        });
      });
    });
    // Keep the chain alive whether the turn succeeds or fails
    this.turnChain = turnExecution.then(
      () => undefined,
      () => undefined
    );
    return turnExecution;
  }

  async interrupt() {
    try {
      await this.queryHandle.interrupt();
    } catch (interruptError) {
      emitLog("warn", `claude interrupt failed: ${interruptError?.message ?? interruptError}`);
    }
    const interruptedTurn = this.currentTurn;
    this.currentTurn = null;
    interruptedTurn?.reject(makeBackendError("cancelled", "turn cancelled"));
  }

  async setModel(modelAlias) {
    if (modelAlias === this.modelAlias) return;
    try {
      await this.queryHandle.setModel(modelAlias);
      this.modelAlias = modelAlias;
    } catch (setModelError) {
      emitLog("warn", `claude setModel failed: ${setModelError?.message ?? setModelError}`);
    }
  }

  close() {
    this.inputStream.end();
  }
}

function makeBackendError(code, message) {
  const backendError = new Error(message);
  backendError.clickyErrorCode = code;
  backendError.clickyBackend = "claude";
  return backendError;
}

/** workspaceId → ClaudeWorkspaceSession */
const activeSessions = new Map();

function obtainSession(workspaceId, modelAlias, effortLevel) {
  let session = activeSessions.get(workspaceId);
  if (session && session.isDead) {
    activeSessions.delete(workspaceId);
    session = null;
  }
  if (!session) {
    session = new ClaudeWorkspaceSession(workspaceId, modelAlias, effortLevel);
    activeSessions.set(workspaceId, session);
  }
  return session;
}

function recreateSessionWithEffort(workspaceId, modelAlias, effortLevel) {
  const existingSession = activeSessions.get(workspaceId);
  existingSession?.close();
  activeSessions.delete(workspaceId);

  const session = new ClaudeWorkspaceSession(workspaceId, modelAlias, effortLevel);
  activeSessions.set(workspaceId, session);
  return session;
}

/** Detects the runtime telling us a slash command wasn't recognized. */
function looksLikeUnknownSlashCommand(resultText) {
  return /unknown (slash )?command|no such (slash )?command|command not found/i.test(
    resultText
  );
}

/**
 * Runs one chat turn against a workspace session.
 * teachIntent sends the text as the real `/teach` slash command; if the
 * runtime doesn't recognize it, retries once with an explicit instruction to
 * read and follow the unmodified SKILL.md (still the vanilla skill).
 */
export async function runClaudeChatTurn({
  requestId,
  workspaceId,
  model,
  effort,
  text,
  images,
  teachIntent,
  onStatus,
}) {
  const modelAlias = resolveClaudeModelAlias(model);
  const effortLevel = resolveClaudeEffortLevel(effort);
  let session = obtainSession(workspaceId, modelAlias, effortLevel);
  if (session.effortLevel !== effortLevel) {
    session = recreateSessionWithEffort(workspaceId, modelAlias, effortLevel);
  }
  await session.setModel(modelAlias);

  const turnText = teachIntent ? `/teach ${text}` : text;

  let turnResult;
  try {
    turnResult = await session.runTurn(requestId, turnText, images, onStatus);
  } catch (turnError) {
    const storedClaudeSessionId = readWorkspaceMetadata(workspaceId)?.claudeSessionId;
    const turnErrorMessage = String(turnError?.message ?? "");
    const staleSessionInternalError =
      turnError.clickyErrorCode === "internal" &&
      /error_during_execution|No conversation found|session.*not.*found/i.test(turnErrorMessage);

    // Resuming a corrupted or deleted transcript surfaces as error_during_execution,
    // which would otherwise brick the workspace until .clicky.json is hand-edited.
    if (
      (turnError.clickyErrorCode === "node_backend_crash" || staleSessionInternalError) &&
      storedClaudeSessionId
    ) {
      emitLog("warn", `retrying without stale claude session id for ${workspaceId}`);
      updateWorkspaceMetadata(workspaceId, { claudeSessionId: null });
      activeSessions.delete(workspaceId);
      session = obtainSession(workspaceId, modelAlias, effortLevel);
      turnResult = await session.runTurn(requestId, turnText, images, onStatus);
    } else {
      throw turnError;
    }
  }

  if (teachIntent && looksLikeUnknownSlashCommand(turnResult.text)) {
    emitLog("warn", "/teach slash command not recognized — falling back to explicit SKILL.md instruction");
    const fallbackText = `Read the file .agents/skills/teach/SKILL.md in this directory and follow its instructions exactly. My topic: ${text}`;
    turnResult = await session.runTurn(requestId, fallbackText, images, onStatus);
  }

  return turnResult;
}

/**
 * One-shot query with a fully custom system prompt and no tools — used by
 * the onboarding demo. No session, no workspace state.
 */
export async function runClaudeOneShot({ text, images, systemPrompt, model }) {
  const singleMessageStream = new PushableMessageStream();
  singleMessageStream.push({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: buildUserContentBlocks(text, images) },
  });
  singleMessageStream.end();

  const oneShotQuery = query({
    prompt: singleMessageStream,
    options: {
      model: resolveClaudeModelAlias(model),
      systemPrompt,
      settingSources: [],
      permissionMode: "dontAsk",
      disallowedTools: ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task"],
      maxTurns: 1,
    },
  });

  let finalText = "";
  for await (const sdkMessage of oneShotQuery) {
    if (sdkMessage.type === "result") {
      if (sdkMessage.subtype === "success" && !sdkMessage.is_error) {
        finalText = sdkMessage.result ?? "";
      } else {
        throw makeBackendError("internal", sdkMessage.result ?? "one-shot failed");
      }
    }
  }
  return { text: finalText };
}

/** Cancels the in-flight turn (if any) for the workspace running requestId. */
export async function cancelClaudeTurn(targetRequestId) {
  for (const session of activeSessions.values()) {
    if (session.currentTurn?.requestId === targetRequestId) {
      await session.interrupt();
      return true;
    }
  }
  return false;
}

export async function resetClaudeSession(workspaceId) {
  const session = activeSessions.get(workspaceId);
  session?.close();
  activeSessions.delete(workspaceId);
  updateWorkspaceMetadata(workspaceId, { claudeSessionId: null });
  return true;
}

/** Bash commands run during the current or most recent turn in a workspace. */
export function recentClaudeBashCommands(workspaceId) {
  const session = activeSessions.get(workspaceId);
  if (!session) return [];
  const inFlightCommands = session.currentTurn?.bashCommands ?? [];
  return [...session.lastTurnBashCommands, ...inFlightCommands];
}

export function closeAllClaudeSessions() {
  for (const session of activeSessions.values()) {
    session.close();
  }
  activeSessions.clear();
}
