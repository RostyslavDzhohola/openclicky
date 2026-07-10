// Codex backend: one persistent Codex SDK thread per workspace.
//
// The Codex SDK wraps the codex CLI. With no apiKey passed and no
// OPENAI_API_KEY/CODEX_API_KEY in the environment (guaranteed by
// src/env.mjs), the CLI uses the ChatGPT-plan login cached by `codex login`
// with a relocated CODEX_HOME whose auth.json symlinks to ~/.codex/auth.json —
// login stays shared while config is isolated. The CLI's sessions/rollouts
// consequently live under the app's codex-home instead of ~/.codex/sessions.
//
// Thread ids are persisted to each workspace's .clicky.json so a sidecar
// restart resumes the same conversation via codex.resumeThread().

import { tmpdir } from "node:os";
import { Codex } from "@openai/codex-sdk";
import { buildCodexChildEnvironment } from "./codexHome.mjs";
import { emitLog } from "./protocol.mjs";
import { codexSubagentCapabilityStatus } from "./agentActivity.mjs";
import {
  readWorkspaceMetadata,
  updateWorkspaceMetadata,
  workspacePath,
} from "./workspaces.mjs";

// See codexHome.mjs for the isolated config and shared-login contract.
const codexClient = new Codex({ env: buildCodexChildEnvironment() });

function resolveCodexModel(requestedModel) {
  const model = String(requestedModel ?? "").trim();
  if (model === "" || model === "default") {
    return null;
  }
  if (/^claude/i.test(model)) {
    emitLog("warn", `ignoring non-codex model override ${model}`);
    return null;
  }
  return model;
}

function resolveCodexEffortLevel(requestedEffort) {
  const effortLevel = String(requestedEffort ?? "").trim().toLowerCase();
  if (["minimal", "low", "medium", "high", "xhigh"].includes(effortLevel)) {
    return effortLevel;
  }
  return null;
}

class CodexWorkspaceSession {
  constructor(workspaceId, model, effortLevel) {
    this.workspaceId = workspaceId;
    this.model = model;
    this.effortLevel = effortLevel;
    this.turnChain = Promise.resolve();
    this.currentTurn = null; // {requestId, abortController, shellCommands}
    this.lastTurnShellCommands = [];

    this.thread = this.createThread(model, effortLevel);
  }

  buildThreadOptions(model, effortLevel) {
    const threadOptions = {
      workingDirectory: workspacePath(this.workspaceId),
      skipGitRepoCheck: true,
      // Deliberate parity with the Claude backend's bypassPermissions:
      // workspace-write would block the network fetches the teach skill
      // needs for RESOURCES.md and the `open` command for finished lessons.
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    };
    if (model) {
      threadOptions.model = model;
    }
    if (effortLevel) {
      threadOptions.modelReasoningEffort = effortLevel;
    }
    return threadOptions;
  }

  createThread(model, effortLevel) {
    const threadOptions = this.buildThreadOptions(model, effortLevel);

    const savedThreadId = readWorkspaceMetadata(this.workspaceId)?.codexThreadId ?? null;
    return savedThreadId
      ? codexClient.resumeThread(savedThreadId, threadOptions)
      : codexClient.startThread(threadOptions);
  }

  rebuildThread(model, effortLevel) {
    this.model = model;
    this.effortLevel = effortLevel;
    this.thread = this.createThread(model, effortLevel);
  }

  buildTurnInput(text, images) {
    const inputItems = [];
    for (const image of images ?? []) {
      inputItems.push({ type: "local_image", path: image.path });
      if (image.label) {
        inputItems.push({ type: "text", text: image.label });
      }
    }
    inputItems.push({ type: "text", text });
    return inputItems;
  }

  runTurn(requestId, text, images, onStatus) {
    const turnExecution = this.turnChain.then(async () => {
      const abortController = new AbortController();
      this.currentTurn = { requestId, abortController, shellCommands: [] };
      onStatus?.({ phase: "thinking" });

      const turnStartTime = Date.now();
      let finalResponseText = "";
      let turnFailure = null;

      try {
        const { events } = await this.thread.runStreamed(
          this.buildTurnInput(text, images),
          { signal: abortController.signal }
        );

        for await (const threadEvent of events) {
          switch (threadEvent.type) {
            case "thread.started":
              if (threadEvent.thread_id) {
                updateWorkspaceMetadata(this.workspaceId, {
                  codexThreadId: threadEvent.thread_id,
                });
              }
              break;

            case "item.completed": {
              const completedItem = threadEvent.item;
              if (completedItem.type === "agent_message") {
                finalResponseText = completedItem.text;
              } else if (completedItem.type === "command_execution") {
                this.currentTurn?.shellCommands.push(completedItem.command);
                onStatus?.({
                  phase: "tool",
                  tool: "shell",
                  detail:
                    completedItem.command.length > 160
                      ? completedItem.command.slice(0, 160) + "…"
                      : completedItem.command,
                });
              } else if (completedItem.type === "file_change") {
                onStatus?.({ phase: "tool", tool: "edit", detail: "" });
              } else if (completedItem.type === "web_search") {
                onStatus?.({ phase: "tool", tool: "web_search", detail: "" });
              } else if (completedItem.type === "mcp_tool_call") {
                onStatus?.({ phase: "tool", tool: "mcp", detail: "" });
              }
              break;
            }

            case "turn.failed":
              turnFailure = threadEvent.error?.message ?? "codex turn failed";
              break;

            case "error":
              turnFailure = threadEvent.message ?? "codex stream error";
              break;
          }
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          throw makeBackendError("cancelled", "turn cancelled");
        }
        throw toBackendError(streamError);
      } finally {
        this.lastTurnShellCommands = this.currentTurn?.shellCommands ?? [];
        this.currentTurn = null;
      }

      if (abortController.signal.aborted) {
        throw makeBackendError("cancelled", "turn cancelled");
      }
      if (turnFailure) {
        throw toBackendError(new Error(turnFailure));
      }

      // The thread id can also become available only after the first turn
      const threadId = this.thread.id;
      if (threadId) {
        updateWorkspaceMetadata(this.workspaceId, { codexThreadId: threadId });
      }

      return {
        text: finalResponseText,
        sessionId: threadId ?? null,
        durationMs: Date.now() - turnStartTime,
      };
    });

    this.turnChain = turnExecution.then(
      () => undefined,
      () => undefined
    );
    return turnExecution;
  }

  cancel() {
    this.currentTurn?.abortController.abort();
  }
}

function makeBackendError(code, message) {
  const backendError = new Error(message);
  backendError.clickyErrorCode = code;
  backendError.clickyBackend = "codex";
  return backendError;
}

function toBackendError(originalError) {
  const message = String(originalError?.message ?? originalError);
  if (message.includes("not supported when using Codex") || message.includes('"type":"invalid_request_error"')) {
    return makeBackendError("internal", message);
  }
  const isAuthProblem = /401|unauthorized|not logged in|login|authent/i.test(message);
  return makeBackendError(
    isAuthProblem ? "auth_required" : "internal",
    isAuthProblem
      ? "codex login expired or missing — run `codex login` in terminal"
      : message
  );
}

/** workspaceId → CodexWorkspaceSession */
const activeSessions = new Map();

function obtainSession(workspaceId, model, effortLevel) {
  let session = activeSessions.get(workspaceId);
  if (!session) {
    session = new CodexWorkspaceSession(workspaceId, model, effortLevel);
    activeSessions.set(workspaceId, session);
  } else if (session.model !== model || session.effortLevel !== effortLevel) {
    session.rebuildThread(model, effortLevel);
  }
  return session;
}

export async function runCodexChatTurn({
  requestId,
  workspaceId,
  model,
  effort,
  text,
  images,
  teachIntent,
  onStatus,
}) {
  const resolvedModel = resolveCodexModel(model);
  const effortLevel = resolveCodexEffortLevel(effort);
  let session = obtainSession(workspaceId, resolvedModel, effortLevel);
  const turnText = teachIntent ? `$teach ${text}` : text;

  onStatus?.(codexSubagentCapabilityStatus());

  let turnResult;
  try {
    turnResult = await session.runTurn(requestId, turnText, images, onStatus);
  } catch (turnError) {
    // A stale thread id makes resumeThread fail on first use — retry fresh once
    if (
      turnError.clickyErrorCode === "internal" &&
      readWorkspaceMetadata(workspaceId)?.codexThreadId &&
      /thread|resume|not found/i.test(turnError.message)
    ) {
      emitLog("warn", `retrying without stale codex thread id for ${workspaceId}`);
      updateWorkspaceMetadata(workspaceId, { codexThreadId: null });
      activeSessions.delete(workspaceId);
      // Reassign so the teach fallback below also runs on the fresh session,
      // not the stale one that was just discarded.
      session = obtainSession(workspaceId, resolvedModel, effortLevel);
      turnResult = await session.runTurn(requestId, turnText, images, onStatus);
    } else {
      throw turnError;
    }
  }

  if (teachIntent && /unknown (slash )?command|no such skill|command not found/i.test(turnResult.text)) {
    emitLog("warn", "$teach not recognized — falling back to explicit SKILL.md instruction");
    const fallbackText = `Read the file .agents/skills/teach/SKILL.md in this directory and follow its instructions exactly. My topic: ${text}`;
    turnResult = await session.runTurn(requestId, fallbackText, images, onStatus);
  }

  return turnResult;
}

/**
 * One-shot turn for the onboarding demo. Codex has no system-prompt
 * parameter, so the instructions are prepended to the user text. Runs in a
 * throwaway read-only thread in the temp directory.
 */
export async function runCodexOneShot({ text, images, systemPrompt }) {
  const oneShotThread = codexClient.startThread({
    workingDirectory: tmpdir(),
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });

  const inputItems = [];
  for (const image of images ?? []) {
    inputItems.push({ type: "local_image", path: image.path });
    if (image.label) {
      inputItems.push({ type: "text", text: image.label });
    }
  }
  inputItems.push({ type: "text", text: `${systemPrompt}\n\n${text}` });

  try {
    const completedTurn = await oneShotThread.run(inputItems);
    return { text: completedTurn.finalResponse ?? "" };
  } catch (oneShotError) {
    throw toBackendError(oneShotError);
  }
}

export async function cancelCodexTurn(targetRequestId) {
  for (const session of activeSessions.values()) {
    if (session.currentTurn?.requestId === targetRequestId) {
      session.cancel();
      return true;
    }
  }
  return false;
}

export async function resetCodexSession(workspaceId) {
  const session = activeSessions.get(workspaceId);
  session?.cancel();
  activeSessions.delete(workspaceId);
  updateWorkspaceMetadata(workspaceId, { codexThreadId: null });
  return true;
}

/** Shell commands run during the current or most recent turn in a workspace. */
export function recentCodexShellCommands(workspaceId) {
  const session = activeSessions.get(workspaceId);
  if (!session) return [];
  const inFlightCommands = session.currentTurn?.shellCommands ?? [];
  return [...session.lastTurnShellCommands, ...inFlightCommands];
}
