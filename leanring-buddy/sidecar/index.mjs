// Clicky brain sidecar entry point.
//
// Reads NDJSON requests from stdin, emits NDJSON events on stdout. Spawned
// and supervised by the macOS app (SidecarProcessManager.swift); also
// drivable from a terminal via test/drive.mjs. Exits when stdin closes, so
// its lifetime can never outlive the app that spawned it.

import { createInterface } from "node:readline";
import { sanitizeProcessEnvForSubscriptionAuth } from "./src/env.mjs";

// Must happen before any SDK import spawns a child process.
sanitizeProcessEnvForSubscriptionAuth();

const { emitEvent, emitError, emitLog, parseRequestLine } = await import(
  "./src/protocol.mjs"
);
const { checkAuthStatus } = await import("./src/auth.mjs");
const {
  createWorkspace,
  describeWorkspace,
  ensureChatWorkspaceExists,
  clearChatSessionIds,
  listWorkspaces,
  lessonsRootDirectory,
  workspaceExists,
  CHAT_WORKSPACE_ID,
  GENERAL_WORKSPACE_ID,
} = await import("./src/workspaces.mjs");
const { parseTeachTag } = await import("./src/teachTag.mjs");
const { buildTopicRosterText, composeChatTurnText } = await import("./src/topicRoster.mjs");
const { regenerateLessonsDashboard, lessonsDashboardPath } = await import(
  "./src/lessonsDashboard.mjs"
);
const {
  runClaudeChatTurn,
  runClaudeOneShot,
  cancelClaudeTurn,
  resetClaudeSession,
  closeAllClaudeSessions,
} = await import("./src/claudeBackend.mjs");
const {
  runCodexChatTurn,
  runCodexOneShot,
  cancelCodexTurn,
  resetCodexSession,
} = await import("./src/codexBackend.mjs");
const { ensureTeachSkillInstalled, teachSkillInstallState } = await import(
  "./src/teachSkill.mjs"
);
const { watchWorkspaceLessons } = await import("./src/lessonWatcher.mjs");

const SIDECAR_VERSION = "1.0.0";

const CHAT_IDLE_RESET_MS = Number(process.env.CLICKY_CHAT_IDLE_MS ?? 600_000);
let chatIdleResetTimer = null;

function armChatIdleReset() {
  clearTimeout(chatIdleResetTimer);
  chatIdleResetTimer = setTimeout(async () => {
    emitLog("info", "chat idle window elapsed — resetting ephemeral chat sessions");
    try {
      await resetClaudeSession(CHAT_WORKSPACE_ID);
      await resetCodexSession(CHAT_WORKSPACE_ID);
    } catch (resetError) {
      emitLog("warn", `chat idle reset failed: ${String(resetError?.message ?? resetError)}`);
    }
  }, CHAT_IDLE_RESET_MS);
  // Never keep the process alive just for the reset timer.
  chatIdleResetTimer.unref?.();
}

/**
 * Builds a lesson in the topic's persistent teach session, in the background.
 * The chat result has already been emitted — failures surface as a dedicated
 * teachError event the app speaks, and success surfaces as the existing
 * lessonCreated event from the watcher.
 */
async function dispatchTeachInstructions({ backend, model, topicText, instructions }) {
  let workspace;
  try {
    workspace = createWorkspace(topicText);
    const teachInstall = await ensureTeachSkillInstalled(workspace.path);
    if (!teachInstall.installed) {
      emitEvent({ type: "teachError", workspaceId: workspace.id, topicName: topicText, message: teachInstall.message });
      return;
    }
    regenerateLessonsDashboard();
    watchWorkspaceLessons(workspace.id, backend);

    // Lesson quality beats latency: dispatched teach turns always run at a
    // deep reasoning tier regardless of the panel's thinking setting — codex
    // at its top tier, claude at "high" (its "max" is disproportionately slow
    // for lesson work). The chat plane keeps the user's own configuration.
    const lessonEffortLevel = backend === "codex" ? "xhigh" : "high";

    const groundedInstructions =
      instructions +
      "\n\nbefore writing the lesson, use web search to ground your understanding of this topic in current, accurate information — verify key facts and examples rather than relying on memory.";

    const dispatchArguments = {
      requestId: `teach-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: workspace.id,
      model,
      effort: lessonEffortLevel,
      text: groundedInstructions,
      images: [],
      teachIntent: true,
      onStatus: null,
    };
    let turnResult;
    if (backend === "codex") {
      turnResult = await runCodexChatTurn(dispatchArguments);
    } else {
      turnResult = await runClaudeChatTurn(dispatchArguments);
    }
    const resultPreview = String(turnResult?.text ?? "").slice(0, 200);
    emitLog("info", `teach dispatch for ${workspace.id} finished: ${resultPreview}`);
  } catch (dispatchError) {
    emitEvent({
      type: "teachError",
      workspaceId: workspace?.id ?? null,
      topicName: topicText,
      message: String(dispatchError?.message ?? dispatchError),
    });
  }
}

async function handleChatRequest(request) {
  // The chat plane owns every voice turn. An explicit non-general workspaceId
  // is the legacy direct path, kept for the terminal drive harness.
  const isChatPlaneTurn =
    !request.workspaceId || request.workspaceId === GENERAL_WORKSPACE_ID;
  const workspaceId = isChatPlaneTurn ? CHAT_WORKSPACE_ID : request.workspaceId;

  if (!isChatPlaneTurn && !workspaceExists(workspaceId)) {
    emitError(request.id, "workspace_missing", `workspace "${workspaceId}" does not exist`);
    return;
  }

  watchWorkspaceLessons(workspaceId, request.backend);

  const onStatus = (statusUpdate) => {
    emitEvent({ id: request.id, type: "status", ...statusUpdate });
  };

  let turnText = request.text ?? "";
  if (isChatPlaneTurn) {
    try {
      turnText = composeChatTurnText(turnText, buildTopicRosterText());
    } catch (rosterError) {
      emitLog("warn", `topic roster build failed: ${String(rosterError?.message ?? rosterError)}`);
    }
  }

  const chatTurnArguments = {
    requestId: request.id,
    workspaceId,
    model: request.model,
    effort: request.effort,
    text: turnText,
    images: request.images ?? [],
    teachIntent: !isChatPlaneTurn && request.teachIntent === true,
    onStatus,
  };

  // A turn in flight is activity; the inactivity window must never expire mid-turn.
  if (isChatPlaneTurn) {
    clearTimeout(chatIdleResetTimer);
  }

  try {
    const turnResult =
      request.backend === "codex"
        ? await runCodexChatTurn(chatTurnArguments)
        : await runClaudeChatTurn(chatTurnArguments);

    let responseText = turnResult.text;
    if (isChatPlaneTurn) {
      const { cleanedText, dispatch } = parseTeachTag(responseText);
      responseText = cleanedText;
      if (dispatch) {
        // Fire-and-forget: a minutes-long lesson build never blocks the chat.
        void dispatchTeachInstructions({
          backend: request.backend,
          model: request.model,
          topicText: dispatch.topicText,
          instructions: dispatch.instructions,
        });
      }
    }

    emitEvent({
      id: request.id,
      type: "result",
      text: responseText,
      sessionId: turnResult.sessionId ?? null,
      durationMs: turnResult.durationMs ?? null,
    });
  } finally {
    if (isChatPlaneTurn) {
      // A turn that fails or is cancelled still ends activity — the idle window must re-arm or ephemerality is lost.
      armChatIdleReset();
    }
  }
}

async function handleOneShotRequest(request) {
  const oneShotArguments = {
    text: request.text ?? "",
    images: request.images ?? [],
    systemPrompt: request.systemPrompt ?? "",
    model: request.model,
  };
  const oneShotResult =
    request.backend === "codex"
      ? await runCodexOneShot(oneShotArguments)
      : await runClaudeOneShot(oneShotArguments);
  emitEvent({ id: request.id, type: "result", text: oneShotResult.text });
}

async function handleRequest(request) {
  switch (request.type) {
    case "chat":
      await handleChatRequest(request);
      break;

    case "oneShot":
      await handleOneShotRequest(request);
      break;

    case "createWorkspace": {
      const workspace = createWorkspace(request.name ?? "topic");
      const teachInstall = await ensureTeachSkillInstalled(workspace.path);
      if (!teachInstall.installed) {
        emitError(request.id, "skill_install_failed", teachInstall.message);
        return;
      }
      emitEvent({ id: request.id, type: "result", workspace: describeWorkspace(workspace.id) });
      break;
    }

    case "listWorkspaces":
      emitEvent({ id: request.id, type: "result", workspaces: listWorkspaces() });
      break;

    case "authStatus": {
      const authStatus = await checkAuthStatus();
      emitEvent({
        id: request.id,
        type: "result",
        claude: authStatus.claude,
        codex: authStatus.codex,
        teachSkill: teachSkillInstallState(),
      });
      break;
    }

    case "resetSession": {
      const workspaceId = request.workspaceId ?? GENERAL_WORKSPACE_ID;
      if (!workspaceExists(workspaceId)) {
        emitError(request.id, "workspace_missing", `workspace "${workspaceId}" does not exist`);
        return;
      }
      if (request.backend === "codex") {
        await resetCodexSession(workspaceId);
      } else {
        await resetClaudeSession(workspaceId);
      }
      emitEvent({ id: request.id, type: "result", reset: true });
      break;
    }

    case "cancel": {
      const wasCancelled =
        (await cancelClaudeTurn(request.targetId)) ||
        (await cancelCodexTurn(request.targetId));
      emitEvent({ id: request.id, type: "result", cancelled: wasCancelled });
      break;
    }

    case "shutdown":
      emitEvent({ id: request.id, type: "result", shuttingDown: true });
      shutdown(0);
      break;

    default:
      emitError(request.id, "internal", `unknown request type "${request.type}"`);
  }
}

function shutdown(exitCode) {
  try {
    closeAllClaudeSessions();
  } catch {
    // best-effort cleanup
  }
  process.exit(exitCode);
}

// --- Startup ---

ensureChatWorkspaceExists();
clearChatSessionIds();
regenerateLessonsDashboard();
// Watch every existing topic so lessons created by any dispatch (or by a
// terminal session in the same folder) refresh the dashboard and notify the app.
for (const workspace of listWorkspaces()) {
  if (workspace.id !== GENERAL_WORKSPACE_ID) {
    watchWorkspaceLessons(workspace.id, "claude");
  }
}

// Bootstrap the teach-skill template in the background; failures are
// remembered and surfaced when a workspace is created or auth is checked.
ensureTeachSkillInstalled(null).catch((bootstrapError) => {
  emitLog("warn", `teach skill bootstrap failed: ${bootstrapError?.message ?? bootstrapError}`);
});

const stdinReader = createInterface({ input: process.stdin });

stdinReader.on("line", (line) => {
  const request = parseRequestLine(line);
  if (!request) return;

  handleRequest(request).catch((requestError) => {
    const errorCode = requestError?.clickyErrorCode ?? "internal";
    if (errorCode !== "cancelled") {
      emitLog("error", `request ${request.id} (${request.type}) failed: ${requestError?.message ?? requestError}`);
    }
    emitError(request.id, errorCode, String(requestError?.message ?? requestError), requestError?.clickyBackend);
  });
});

stdinReader.on("close", () => {
  emitLog("info", "stdin closed — shutting down");
  shutdown(0);
});

emitEvent({
  type: "ready",
  version: SIDECAR_VERSION,
  node: process.version,
  sidecarPath: process.cwd(),
  lessonsRoot: lessonsRootDirectory(),
  dashboardPath: lessonsDashboardPath(),
});
