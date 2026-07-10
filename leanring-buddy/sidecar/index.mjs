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
  workspacePath,
  slugifyTopicName,
  CHAT_WORKSPACE_ID,
  GENERAL_WORKSPACE_ID,
} = await import("./src/workspaces.mjs");
const { parseTeachTag } = await import("./src/teachTag.mjs");
const {
  INTERVIEW_PREAMBLE,
  LESSON_GROUNDING_NOTE,
  POST_INTERVIEW_BUILD_INSTRUCTIONS,
  INTERVIEW_WRAP_UP_NOTE,
  BUILD_HANDOFF_SPOKEN_NOTE,
  missionFileExists,
  createInterviewTracker,
} = await import("./src/teachInterview.mjs");
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
const { clearPendingDispatch, recordPendingDispatch, takePendingDispatches } = await import(
  "./src/teachDispatchQueue.mjs"
);

const SIDECAR_VERSION = "1.0.0";

const CHAT_IDLE_RESET_MS = Number(process.env.CLICKY_CHAT_IDLE_MS ?? 600_000);
let chatIdleResetTimer = null;
const interviewTracker = createInterviewTracker();
const INTERVIEW_IDLE_EXPIRY_MS = Number(process.env.CLICKY_INTERVIEW_IDLE_MS ?? 600_000);
let interviewExpiryTimer = null;
// Cancels that arrive between the chat turn and the interview turn hit no
// in-flight backend turn; remember them so a cancelled setup never arms
// interview routing (entries are dropped when their chat request finishes).
const cancelledChatRequestIds = new Set();

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

function clearInterviewExpiryTimer() {
  clearTimeout(interviewExpiryTimer);
  interviewExpiryTimer = null;
}

function armInterviewExpiry() {
  clearInterviewExpiryTimer();
  interviewExpiryTimer = setTimeout(() => {
    const activeInterview = interviewTracker.activeInterview;
    if (activeInterview) {
      emitLog(
        "info",
        `interview idle window elapsed — abandoning the mission interview for ${activeInterview.workspaceId}`
      );
      interviewTracker.expire();
    }
    interviewExpiryTimer = null;
  }, INTERVIEW_IDLE_EXPIRY_MS);
  // Never keep the process alive just for the interview expiry timer.
  interviewExpiryTimer.unref?.();
}

async function prepareTeachWorkspace({ topicText, backend }) {
  const workspace = createWorkspace(topicText);
  const teachInstall = await ensureTeachSkillInstalled(workspace.path);
  if (!teachInstall.installed) {
    emitEvent({
      type: "teachError",
      workspaceId: workspace.id,
      topicName: topicText,
      message: teachInstall.message,
    });
    return null;
  }
  regenerateLessonsDashboard();
  watchWorkspaceLessons(workspace.id, backend);
  return workspace;
}

/**
 * Builds a lesson in the topic's persistent teach session, in the background.
 * The chat result has already been emitted — failures surface as a dedicated
 * teachError event the app speaks, and success surfaces as the existing
 * lessonCreated event from the watcher.
 */
async function dispatchTeachInstructions({ backend, model, topicText, instructions }) {
  const requestId = `teach-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  recordPendingDispatch({
    id: requestId,
    backend,
    model,
    topicText,
    instructions,
    createdAt: Date.now(),
  });

  let workspace;
  try {
    workspace = await prepareTeachWorkspace({ topicText, backend });
    if (!workspace) return;

    // Lesson quality beats latency: dispatched teach turns always run at a
    // deep reasoning tier regardless of the panel's thinking setting — codex
    // at its top tier, claude at "high" (its "max" is disproportionately slow
    // for lesson work). The chat plane keeps the user's own configuration.
    const lessonEffortLevel = backend === "codex" ? "xhigh" : "high";

    const groundedInstructions = instructions + LESSON_GROUNDING_NOTE;

    const dispatchArguments = {
      requestId,
      workspaceId: workspace.id,
      model,
      effort: lessonEffortLevel,
      text: groundedInstructions,
      images: [],
      teachIntent: true,
      onStatus: null,
    };
    emitLog(
      "info",
      `teach dispatch → ${backend} model=${model ?? "default"} effort=${lessonEffortLevel} workspace=${workspace.id} instructions="${String(instructions).slice(0, 300).replace(/\r?\n/g, " ")}"`
    );
    emitEvent({ type: "teachBuildStarted", workspaceId: workspace.id, topicName: topicText });
    let turnResult;
    if (backend === "codex") {
      turnResult = await runCodexChatTurn(dispatchArguments);
    } else {
      turnResult = await runClaudeChatTurn(dispatchArguments);
    }
    const resultPreview = String(turnResult?.text ?? "").slice(0, 200);
    emitLog("info", `teach dispatch for ${workspace.id} finished: ${resultPreview}`);

    // The workspace notes promise the session that its final message is spoken
    // aloud — honor that for background dispatches too, so a finished build or
    // lesson update is announced instead of dying in the logs. Tags are
    // stripped: a dispatched turn has no screenshot, so a [POINT:...] tag
    // would be meaningless, and no tag should ever be read aloud.
    const spokenWrapUpText = parseTeachTag(String(turnResult?.text ?? ""))
      .cleanedText.replace(/\[POINT:[^\]]*\]/gi, "")
      .trim();
    if (spokenWrapUpText.length > 0) {
      emitEvent({ type: "speak", text: spokenWrapUpText });
    }
  } catch (dispatchError) {
    emitEvent({
      type: "teachError",
      workspaceId: workspace?.id ?? null,
      topicName: topicText,
      message: String(dispatchError?.message ?? dispatchError),
    });
  } finally {
    // Only an abrupt process death should leave work in the durable queue.
    clearPendingDispatch(requestId);
  }
}

async function startInterview({ backend, model, effort, topicText, instructions, requestId, onStatus }) {
  const workspace = await prepareTeachWorkspace({ topicText, backend });
  if (!workspace) return null;

  const interviewTurnArguments = {
    requestId,
    workspaceId: workspace.id,
    model,
    effort,
    text: instructions + "\n\n" + INTERVIEW_PREAMBLE,
    images: [],
    teachIntent: true,
    onStatus,
  };

  // Interview turns are intentionally not durable: after a crash, a missing
  // MISSION.md safely causes the next teach request to begin again.
  const turnResult =
    backend === "codex"
      ? await runCodexChatTurn(interviewTurnArguments)
      : await runClaudeChatTurn(interviewTurnArguments);

  return {
    workspace,
    replyText: turnResult.text,
    lessonCountBeforeInterview: workspace.lessonCount,
  };
}

function concludeInterviewIfMissionCaptured() {
  const activeInterview = interviewTracker.activeInterview;
  if (!activeInterview) return { missionCaptured: false, buildDispatched: false };
  if (!missionFileExists(workspacePath(activeInterview.workspaceId))) {
    return { missionCaptured: false, buildDispatched: false };
  }

  clearInterviewExpiryTimer();
  const completedInterview = interviewTracker.complete();
  emitLog("info", `mission captured for ${completedInterview.workspaceId} — concluding interview`);
  // Pre-feature topics may already own lessons without a mission — only a
  // lesson the interview itself produced means the model jumped ahead.
  if (
    describeWorkspace(completedInterview.workspaceId).lessonCount >
    completedInterview.lessonCountAtInterviewStart
  ) {
    emitLog("info", "lesson already created during the interview — skipping build dispatch");
    return { missionCaptured: true, buildDispatched: false };
  }

  void dispatchTeachInstructions({
    backend: completedInterview.backend,
    model: completedInterview.model,
    topicText: completedInterview.topicText,
    instructions: POST_INTERVIEW_BUILD_INSTRUCTIONS,
  });
  return { missionCaptured: true, buildDispatched: true };
}

async function handleChatRequest(request) {
  // The chat plane owns every voice turn. An explicit non-general workspaceId
  // is the legacy direct path, kept for the terminal drive harness.
  const isChatPlaneTurn =
    !request.workspaceId || request.workspaceId === GENERAL_WORKSPACE_ID;
  const workspaceId = isChatPlaneTurn ? CHAT_WORKSPACE_ID : request.workspaceId;

  const onStatus = (statusUpdate) => {
    emitEvent({ id: request.id, type: "status", ...statusUpdate });
  };

  const activeInterview = interviewTracker.activeInterview;
  if (isChatPlaneTurn && activeInterview) {
    // While a mission interview is active, voice turns stay in the topic's
    // teach session just as they would for a CLI user answering its questions.
    clearTimeout(chatIdleResetTimer);
    clearInterviewExpiryTimer();
    const { reachedTurnCap } = interviewTracker.recordRoutedTurn();
    const routedText =
      (request.text ?? "") + (reachedTurnCap ? INTERVIEW_WRAP_UP_NOTE : "");
    const routedTurnArguments = {
      requestId: request.id,
      workspaceId: activeInterview.workspaceId,
      model: activeInterview.model,
      effort: request.effort,
      text: routedText,
      images: request.images ?? [],
      teachIntent: false,
      onStatus,
    };

    // Keep the original backend so the topic session remains continuous if
    // the user changes the panel's backend while answering the interview.
    watchWorkspaceLessons(activeInterview.workspaceId, activeInterview.backend);

    try {
      const turnResult =
        activeInterview.backend === "codex"
          ? await runCodexChatTurn(routedTurnArguments)
          : await runClaudeChatTurn(routedTurnArguments);
      const { cleanedText, dispatch } = parseTeachTag(turnResult.text);
      if (dispatch) {
        emitLog("warn", `ignoring leaked teach tag from interview workspace ${activeInterview.workspaceId}`);
      }

      const interviewConclusion = concludeInterviewIfMissionCaptured();
      if (!interviewConclusion.missionCaptured) {
        armInterviewExpiry();
      }
      let spokenReplyText = cleanedText;
      if (interviewConclusion.buildDispatched) {
        // The teach session's own wrap-up ("your course is set up") says nothing
        // about the multi-minute build that follows — set that expectation now.
        spokenReplyText = spokenReplyText + BUILD_HANDOFF_SPOKEN_NOTE;
      }
      emitEvent({
        id: request.id,
        type: "result",
        text: spokenReplyText,
        sessionId: turnResult.sessionId ?? null,
        durationMs: turnResult.durationMs ?? null,
      });
    } finally {
      // A failed or cancelled routed turn still ends chat-plane activity.
      armChatIdleReset();
      if (interviewTracker.activeInterview) {
        armInterviewExpiry();
      }
    }
    return;
  }

  if (!isChatPlaneTurn && !workspaceExists(workspaceId)) {
    emitError(request.id, "workspace_missing", `workspace "${workspaceId}" does not exist`);
    return;
  }

  watchWorkspaceLessons(workspaceId, request.backend);

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
        const topicWorkspaceDirectory = workspacePath(slugifyTopicName(dispatch.topicText));
        if (missionFileExists(topicWorkspaceDirectory)) {
          // Mission already captured: a minutes-long lesson build never blocks the chat.
          void dispatchTeachInstructions({
            backend: request.backend,
            model: request.model,
            topicText: dispatch.topicText,
            instructions: dispatch.instructions,
          });
        } else {
          // No mission yet: run the teach skill's own mission interview over voice.
          try {
            // The sync interview turn takes tens of seconds; speak the chat ack now so
            // the user is not left in silence until the first interview question.
            if (responseText.trim().length > 0) {
              emitEvent({ id: request.id, type: "speak", text: responseText });
              responseText = "";
            }
            const interviewStart = await startInterview({
              backend: request.backend,
              model: request.model,
              effort: request.effort,
              topicText: dispatch.topicText,
              instructions: dispatch.instructions,
              requestId: request.id,
              onStatus,
            });
            if (interviewStart) {
              if (cancelledChatRequestIds.has(request.id)) {
                emitLog(
                  "info",
                  `interview start for ${interviewStart.workspace.id} was cancelled mid-setup — not arming interview routing`
                );
              } else {
                const interviewReplyText = (interviewStart.replyText ?? "").trim();
                responseText = [responseText, interviewReplyText]
                  .filter((part) => part.length > 0)
                  .join(" ");
                interviewTracker.begin({
                  workspaceId: interviewStart.workspace.id,
                  backend: request.backend,
                  model: request.model,
                  topicText: dispatch.topicText,
                  lessonCountAtInterviewStart: interviewStart.lessonCountBeforeInterview,
                });
                // The model may capture the mission on the first turn if the
                // tag's instructions already include enough user context.
                const interviewConclusion = concludeInterviewIfMissionCaptured();
                if (!interviewConclusion.missionCaptured) {
                  armInterviewExpiry();
                }
                if (interviewConclusion.buildDispatched) {
                  // The teach session's own wrap-up ("your course is set up") says nothing
                  // about the multi-minute build that follows — set that expectation now.
                  responseText = responseText + BUILD_HANDOFF_SPOKEN_NOTE;
                }
              }
            }
          } catch (interviewError) {
            // A cancelled interview turn is a cancelled chat request, not a
            // teach failure — let the standard cancelled error path handle it.
            if (interviewError?.clickyErrorCode === "cancelled") {
              throw interviewError;
            }
            emitEvent({
              type: "teachError",
              workspaceId: slugifyTopicName(dispatch.topicText),
              topicName: dispatch.topicText,
              message: String(interviewError?.message ?? interviewError),
            });
          }
        }
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
    cancelledChatRequestIds.delete(request.id);
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
      if (!wasCancelled && request.targetId) {
        cancelledChatRequestIds.add(request.targetId);
      }
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

const { pendingDispatches, droppedStaleCount } = takePendingDispatches(24 * 60 * 60 * 1000);
for (const pendingDispatch of pendingDispatches) {
  emitLog(
    "info",
    `recovering pending teach dispatch → ${pendingDispatch.backend} topic=${pendingDispatch.topicText}`
  );
  const recoveredTopicWorkspaceDirectory = workspacePath(slugifyTopicName(pendingDispatch.topicText));
  // Re-dispatching creates a fresh durable entry before any lesson work starts.
  // A pre-feature durable entry can have no mission, and recovery has no chat
  // turn available to relay an interview into.
  void dispatchTeachInstructions({
    backend: pendingDispatch.backend,
    model: pendingDispatch.model,
    topicText: pendingDispatch.topicText,
    instructions: missionFileExists(recoveredTopicWorkspaceDirectory)
      ? pendingDispatch.instructions
      : pendingDispatch.instructions +
        "\n\nno one is available to answer questions in this session. if MISSION.md is missing, write a reasonable MISSION.md yourself from these instructions first, then build the lesson.",
  });
}
if (droppedStaleCount > 0) {
  emitLog("info", `dropped ${droppedStaleCount} stale pending teach dispatches`);
}

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
