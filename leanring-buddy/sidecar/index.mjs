// Clicky brain sidecar entry point.
//
// Reads NDJSON requests from stdin, emits NDJSON events on stdout. Spawned
// and supervised by the macOS app (SidecarProcessManager.swift); also
// drivable from a terminal via test/drive.mjs. Exits when stdin closes, so
// its lifetime can never outlive the app that spawned it.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { sanitizeProcessEnvForSubscriptionAuth } from "./src/env.mjs";

// Must happen before any SDK import spawns a child process.
sanitizeProcessEnvForSubscriptionAuth();

const { emitEvent, emitError, emitLog, parseRequestLine } = await import(
  "./src/protocol.mjs"
);
const { traceAgentEvent } = await import("./src/agentTrace.mjs");
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
const { parseCancelTag } = await import("./src/cancelTag.mjs");
const { parseOpenTag, resolveOpenLessonPath } = await import("./src/openTag.mjs");
const {
  createTeachDispatchRegistry,
  listLessonFileNames,
  removeLessonFilesCreatedDuringDispatch,
} = await import("./src/teachDispatchRegistry.mjs");
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
const {
  beginTeachTurnHold,
  endTeachTurnHold,
  watchWorkspaceLessons,
} = await import("./src/lessonWatcher.mjs");
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
const teachDispatchRegistry = createTeachDispatchRegistry();

function handleOpenLessonRequest(openRequest, correlation = {}) {
  if (!openRequest) return;

  const resolution = resolveOpenLessonPath({
    lessonsRootDirectory: lessonsRootDirectory(),
    topicSlug: openRequest.topicSlug,
    lessonOrdinal: openRequest.lessonOrdinal,
  });
  if (!resolution.lessonPath) {
    traceAgentEvent("open.requested", {
      ...correlation,
      topicSlug: openRequest.topicSlug,
      lessonOrdinal: openRequest.lessonOrdinal ?? "latest",
      failureReason: resolution.failureReason,
    });
    emitLog(
      "info",
      `open lesson failed slug=${openRequest.topicSlug} ordinal=${openRequest.lessonOrdinal ?? "latest"} reason=${resolution.failureReason}`
    );
    const text = "hmm, i couldn't find that lesson.";
    traceAgentEvent("response.emitted", { ...correlation, channel: "speak", text });
    emitEvent({ type: "speak", text, ...correlation });
    return;
  }

  traceAgentEvent("open.requested", {
    ...correlation,
    topicSlug: openRequest.topicSlug,
    lessonOrdinal: openRequest.lessonOrdinal ?? "latest",
    resolvedPath: resolution.lessonPath,
  });

  emitLog(
    "info",
    `open lesson slug=${openRequest.topicSlug} ordinal=${openRequest.lessonOrdinal ?? "latest"} file=${resolution.lessonPath}`
  );
  const openProcess = spawn("open", [resolution.lessonPath], {
    detached: true,
    stdio: "ignore",
  });
  openProcess.on("error", (openError) => {
    emitLog(
      "info",
      `open lesson failed slug=${openRequest.topicSlug} file=${resolution.lessonPath} reason=${String(openError?.message ?? openError)}`
    );
    const text = "hmm, i couldn't open that lesson.";
    traceAgentEvent("response.emitted", { ...correlation, channel: "speak", text });
    emitEvent({ type: "speak", text, ...correlation });
  });
  openProcess.unref();
}

function parseChatResponseTags(responseText) {
  const teachTagResult = parseTeachTag(responseText);
  const cancelTagResult = parseCancelTag(teachTagResult.cleanedText);
  const openTagResult = parseOpenTag(cancelTagResult.cleanedText);
  return {
    cleanedText: openTagResult.cleanedText,
    teachDispatch: teachTagResult.dispatch,
    cancelRequest: cancelTagResult.cancelRequest,
    openRequest: openTagResult.openRequest,
  };
}

async function handleCancelLessonBuildRequest(cancelRequest) {
  if (!cancelRequest) return;

  const activeDispatch = teachDispatchRegistry.activeDispatch(cancelRequest.topicSlug);
  if (!activeDispatch) {
    emitLog(
      "info",
      `cancel lesson build ignored slug=${cancelRequest.topicSlug} reason=no_active_dispatch`
    );
    return;
  }

  emitLog(
    "info",
    `cancelling lesson build slug=${cancelRequest.topicSlug} requestId=${activeDispatch.requestId}`
  );
  await teachDispatchRegistry.requestCancellation(cancelRequest.topicSlug, {
    cancelBackendTurn: async (entry) => {
      try {
        if (await cancelClaudeTurn(entry.requestId)) {
          return true;
        }
      } catch (claudeCancellationError) {
        emitLog(
          "warn",
          `claude lesson cancellation failed requestId=${entry.requestId} reason=${String(claudeCancellationError?.message ?? claudeCancellationError)}`
        );
      }

      try {
        return await cancelCodexTurn(entry.requestId);
      } catch (codexCancellationError) {
        emitLog(
          "warn",
          `codex lesson cancellation failed requestId=${entry.requestId} reason=${String(codexCancellationError?.message ?? codexCancellationError)}`
        );
        return false;
      }
    },
  });
}

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
      traceAgentEvent("interview.expired", {
        traceId: activeInterview.traceId,
        parentTurnId: activeInterview.parentTurnId,
        interviewId: activeInterview.interviewId,
        agentRole: "topic-interview",
        workspaceId: activeInterview.workspaceId,
      });
      interviewTracker.expire();
    }
    interviewExpiryTimer = null;
  }, INTERVIEW_IDLE_EXPIRY_MS);
  // Never keep the process alive just for the interview expiry timer.
  interviewExpiryTimer.unref?.();
}

async function prepareTeachWorkspace({
  topicText,
  backend,
  shouldEmitTeachError = () => true,
}) {
  const workspace = createWorkspace(topicText);
  const teachInstall = await ensureTeachSkillInstalled(workspace.path);
  if (!teachInstall.installed) {
    // Evaluate this after the async install attempt so a cancellation that
    // arrived during setup can suppress a stale spoken failure event.
    if (shouldEmitTeachError()) {
      emitEvent({
        type: "teachError",
        workspaceId: workspace.id,
        topicName: topicText,
        message: teachInstall.message,
      });
    }
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
async function dispatchTeachInstructions({
  backend,
  model,
  topicText,
  instructions,
  traceId,
  parentTurnId,
  interviewId,
}) {
  const workspaceIdForTopic = slugifyTopicName(topicText);
  if (teachDispatchRegistry.activeDispatch(workspaceIdForTopic)) {
    emitLog(
      "info",
      `teach dispatch skipped topic=${topicText} reason=build_already_in_flight`
    );
    return;
  }

  const requestId = `teach-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dispatchEntry = teachDispatchRegistry.beginDispatch({
    workspaceId: workspaceIdForTopic,
    requestId,
    backend,
    topicText,
  });
  if (!dispatchEntry) {
    emitLog(
      "info",
      `teach dispatch skipped topic=${topicText} reason=build_already_in_flight`
    );
    return;
  }

  const correlation = {
    traceId: traceId ?? parentTurnId ?? requestId,
    parentTurnId,
    dispatchId: requestId,
    interviewId,
    agentRole: "topic-builder",
  };
  recordPendingDispatch({
    id: requestId,
    backend,
    model,
    topicText,
    instructions,
    createdAt: Date.now(),
    ...correlation,
  });
  traceAgentEvent("teach.queued", { ...correlation, backend, model, topicText });

  let workspace;
  let spokenWrapUpText = "";
  let teachTurnHoldStarted = false;
  let teachBuildStartedWasEmitted = false;
  let lessonFileNamesBeforeDispatch = [];
  let dispatchWasCancelled = false;

  function finishCancelledDispatch() {
    dispatchWasCancelled = true;
    let removedLessonFileNames = [];
    if (workspace) {
      try {
        removedLessonFileNames = removeLessonFilesCreatedDuringDispatch({
          lessonsDirectory: join(workspace.path, "lessons"),
          lessonFileNamesBeforeDispatch,
        });
      } catch (lessonCleanupError) {
        emitLog(
          "warn",
          `cancelled teach dispatch cleanup failed workspace=${workspace.id} reason=${String(lessonCleanupError?.message ?? lessonCleanupError)}`
        );
      }
      if (teachTurnHoldStarted) {
        endTeachTurnHold(workspace.id, { discardQueuedLessons: true });
        teachTurnHoldStarted = false;
      }
      if (removedLessonFileNames.length > 0) {
        regenerateLessonsDashboard();
      }
    }

    emitLog(
      "info",
      `teach dispatch cancelled workspace=${workspace?.id ?? workspaceIdForTopic} removedLessonFiles=${JSON.stringify(removedLessonFileNames)}`
    );
    traceAgentEvent("agent.cancelled", {
      ...correlation,
      workspaceId: workspace?.id ?? workspaceIdForTopic,
    });
    if (teachBuildStartedWasEmitted) {
      emitEvent({
        type: "teachBuildCancelled",
        workspaceId: workspace.id,
        topicName: topicText,
        ...correlation,
      });
    }
  }

  try {
    workspace = await prepareTeachWorkspace({
      topicText,
      backend,
      shouldEmitTeachError: () => !dispatchEntry.cancellationRequested,
    });
    if (dispatchEntry.cancellationRequested) {
      finishCancelledDispatch();
      return;
    }
    if (!workspace) return;

    lessonFileNamesBeforeDispatch = listLessonFileNames(join(workspace.path, "lessons"));

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
      onStatus: (statusUpdate) => {
        if (statusUpdate.phase === "thinking") return;
        traceAgentEvent(
          statusUpdate.phase === "capability" ? "capability.unavailable" : "agent.tool",
          { ...correlation, workspaceId: workspace.id, ...statusUpdate }
        );
      },
    };
    if (dispatchEntry.cancellationRequested) {
      finishCancelledDispatch();
      return;
    }

    emitLog(
      "info",
      `teach dispatch → ${backend} model=${model ?? "default"} effort=${lessonEffortLevel} workspace=${workspace.id} instructions="${String(instructions).slice(0, 300).replace(/\r?\n/g, " ")}"`
    );
    beginTeachTurnHold(workspace.id, correlation);
    teachTurnHoldStarted = true;
    traceAgentEvent("teach.started", { ...correlation, workspaceId: workspace.id, backend, model });
    traceAgentEvent("agent.started", { ...correlation, workspaceId: workspace.id, backend, model });
    emitEvent({
      type: "teachBuildStarted",
      workspaceId: workspace.id,
      topicName: topicText,
      ...correlation,
    });
    teachBuildStartedWasEmitted = true;
    let turnResult;
    if (backend === "codex") {
      turnResult = await runCodexChatTurn(dispatchArguments);
    } else {
      turnResult = await runClaudeChatTurn(dispatchArguments);
    }

    if (dispatchEntry.cancellationRequested) {
      finishCancelledDispatch();
      return;
    }

    // The final tool commands, including a non-compliant agent's `open`, are
    // available only after the teach turn resolves. Flush lesson events now
    // so the app and its spoken completion announcement stay in lockstep.
    endTeachTurnHold(workspace.id);
    teachTurnHoldStarted = false;
    const resultPreview = String(turnResult?.text ?? "").slice(0, 200);
    emitLog("info", `teach dispatch for ${workspace.id} finished: ${resultPreview}`);
    traceAgentEvent("agent.completed", {
      ...correlation,
      workspaceId: workspace.id,
      text: String(turnResult?.text ?? ""),
      durationMs: turnResult?.durationMs,
    });
    traceAgentEvent("teach.completed", { ...correlation, workspaceId: workspace.id });

    // The workspace notes promise the session that its final message is spoken
    // aloud — honor that for background dispatches too, so a finished build or
    // lesson update is announced instead of dying in the logs. Tags are
    // stripped: a dispatched turn has no screenshot, so a [POINT:...] tag
    // would be meaningless, and no tag should ever be read aloud.
    spokenWrapUpText = parseTeachTag(String(turnResult?.text ?? ""))
      .cleanedText.replace(/\[POINT:[^\]]*\]/gi, "")
      .trim();
  } catch (dispatchError) {
    if (
      dispatchError?.clickyErrorCode === "cancelled" ||
      dispatchEntry.cancellationRequested
    ) {
      finishCancelledDispatch();
    } else {
      if (teachTurnHoldStarted && workspace) {
        endTeachTurnHold(workspace.id);
        teachTurnHoldStarted = false;
      }
      traceAgentEvent("agent.failed", {
        ...correlation,
        workspaceId: workspace?.id,
        message: String(dispatchError?.message ?? dispatchError),
      });
      traceAgentEvent("teach.failed", {
        ...correlation,
        workspaceId: workspace?.id,
        message: String(dispatchError?.message ?? dispatchError),
      });
      emitEvent({
        type: "teachError",
        workspaceId: workspace?.id ?? null,
        topicName: topicText,
        message: String(dispatchError?.message ?? dispatchError),
        ...correlation,
      });
    }
  } finally {
    if (teachTurnHoldStarted && workspace) {
      endTeachTurnHold(workspace.id, {
        discardQueuedLessons:
          dispatchWasCancelled || dispatchEntry.cancellationRequested,
      });
    }
    // Only an abrupt process death should leave work in the durable queue.
    clearPendingDispatch(requestId);
    teachDispatchRegistry.settleDispatch(workspaceIdForTopic, dispatchEntry);
  }

  // Emit speech after the hold flush: if Clicky needs to open the page, the
  // user sees that single app-side open immediately before this announcement.
  if (spokenWrapUpText.length > 0) {
    traceAgentEvent("response.emitted", {
      ...correlation,
      workspaceId: workspace?.id,
      channel: "speak",
      text: spokenWrapUpText,
    });
    emitEvent({ type: "speak", text: spokenWrapUpText, workspaceId: workspace?.id, ...correlation });
  }
}

async function startInterview({
  backend,
  model,
  effort,
  topicText,
  instructions,
  requestId,
  onStatus,
  traceId,
  interviewId,
}) {
  const workspace = await prepareTeachWorkspace({ topicText, backend });
  if (!workspace) return null;

  const correlation = {
    traceId,
    turnId: requestId,
    parentTurnId: requestId,
    interviewId,
    agentRole: "topic-interview",
  };
  const interviewTurnArguments = {
    requestId,
    workspaceId: workspace.id,
    model,
    effort,
    text: instructions + "\n\n" + INTERVIEW_PREAMBLE,
    images: [],
    teachIntent: true,
    onStatus: (statusUpdate) => onStatus?.(statusUpdate, correlation),
  };

  // Interview turns are intentionally not durable: after a crash, a missing
  // MISSION.md safely causes the next teach request to begin again.
  traceAgentEvent("interview.started", { ...correlation, workspaceId: workspace.id, backend, model });
  traceAgentEvent("agent.started", { ...correlation, workspaceId: workspace.id, backend, model });
  beginTeachTurnHold(workspace.id, correlation);
  let turnResult;
  try {
    turnResult =
      backend === "codex"
        ? await runCodexChatTurn(interviewTurnArguments)
        : await runClaudeChatTurn(interviewTurnArguments);
  } finally {
    // A mission interview should not build a lesson, but this hold preserves
    // correct notification ordering if a model does so despite the prompt.
    endTeachTurnHold(workspace.id);
  }

  traceAgentEvent("agent.completed", {
    ...correlation,
    workspaceId: workspace.id,
    text: turnResult.text,
    durationMs: turnResult.durationMs,
  });

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
  traceAgentEvent("mission.captured", {
    traceId: completedInterview.traceId,
    parentTurnId: completedInterview.parentTurnId,
    interviewId: completedInterview.interviewId,
    agentRole: "topic-interview",
    workspaceId: completedInterview.workspaceId,
  });
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
    traceId: completedInterview.traceId,
    parentTurnId: completedInterview.parentTurnId,
    interviewId: completedInterview.interviewId,
  });
  return { missionCaptured: true, buildDispatched: true };
}

async function handleChatRequest(request) {
  // The chat plane owns every voice turn. An explicit non-general workspaceId
  // is the legacy direct path, kept for the terminal drive harness.
  const isChatPlaneTurn =
    !request.workspaceId || request.workspaceId === GENERAL_WORKSPACE_ID;
  const workspaceId = isChatPlaneTurn ? CHAT_WORKSPACE_ID : request.workspaceId;

  const activeInterview = interviewTracker.activeInterview;
  const traceId = activeInterview?.traceId ?? request.traceId ?? request.id;
  const baseCorrelation = {
    traceId,
    turnId: request.id,
    parentTurnId: activeInterview?.parentTurnId,
    interviewId: activeInterview?.interviewId,
    agentRole: activeInterview ? "topic-interview" : "chat",
    workspaceId: activeInterview?.workspaceId ?? workspaceId,
  };
  traceAgentEvent("turn.received", {
    ...baseCorrelation,
    backend: activeInterview?.backend ?? request.backend,
    model: activeInterview?.model ?? request.model,
    effort: request.effort,
    transcript: request.text ?? "",
    imageCount: request.images?.length ?? 0,
  });

  const onStatus = (statusUpdate, correlation = baseCorrelation) => {
    emitEvent({ id: request.id, type: "status", ...statusUpdate });
    if (statusUpdate.phase === "thinking") return;
    traceAgentEvent(
      statusUpdate.phase === "capability" ? "capability.unavailable" : "agent.tool",
      { ...correlation, ...statusUpdate }
    );
  };

  if (isChatPlaneTurn && activeInterview) {
    // While a mission interview is active, voice turns stay in the topic's
    // teach session just as they would for a CLI user answering its questions.
    clearTimeout(chatIdleResetTimer);
    clearInterviewExpiryTimer();
    const { turnNumber, reachedTurnCap } = interviewTracker.recordRoutedTurn();
    traceAgentEvent("interview.turn", { ...baseCorrelation, turnNumber, reachedTurnCap });
    if (reachedTurnCap) {
      traceAgentEvent("interview.turn-cap", { ...baseCorrelation, turnNumber });
    }
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
      traceAgentEvent("agent.started", {
        ...baseCorrelation,
        backend: activeInterview.backend,
        model: activeInterview.model,
      });
      beginTeachTurnHold(activeInterview.workspaceId, baseCorrelation);
      let turnResult;
      try {
        turnResult =
          activeInterview.backend === "codex"
            ? await runCodexChatTurn(routedTurnArguments)
            : await runClaudeChatTurn(routedTurnArguments);
      } finally {
        // The teach skill can build a lesson mid-interview despite being told
        // not to; defer that lesson notification until its turn is complete.
        endTeachTurnHold(activeInterview.workspaceId);
      }
      const { cleanedText, teachDispatch, cancelRequest, openRequest } =
        parseChatResponseTags(turnResult.text);
      traceAgentEvent("agent.completed", {
        ...baseCorrelation,
        text: turnResult.text,
        durationMs: turnResult.durationMs,
      });
      traceAgentEvent("routing.parsed", {
        ...baseCorrelation,
        rawResponse: turnResult.text,
        cleanedReply: cleanedText,
        route: cancelRequest ? "cancel" : openRequest ? "open" : "interview-continue",
        teachTagDetected: Boolean(teachDispatch),
      });
      if (teachDispatch) {
        emitLog("warn", `ignoring leaked teach tag from interview workspace ${activeInterview.workspaceId}`);
      }
      await handleCancelLessonBuildRequest(cancelRequest);
      handleOpenLessonRequest(openRequest, baseCorrelation);

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
      traceAgentEvent("response.emitted", {
        ...baseCorrelation,
        channel: "result",
        text: spokenReplyText,
      });
      emitEvent({
        id: request.id,
        type: "result",
        text: spokenReplyText,
        sessionId: turnResult.sessionId ?? null,
        durationMs: turnResult.durationMs ?? null,
        ...baseCorrelation,
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
    traceAgentEvent("agent.started", {
      ...baseCorrelation,
      backend: request.backend,
      model: request.model,
      effort: request.effort,
    });
    const turnResult =
      request.backend === "codex"
        ? await runCodexChatTurn(chatTurnArguments)
        : await runClaudeChatTurn(chatTurnArguments);

    traceAgentEvent("agent.completed", {
      ...baseCorrelation,
      text: turnResult.text,
      durationMs: turnResult.durationMs,
    });
    let responseText = turnResult.text;
    if (isChatPlaneTurn) {
      const { cleanedText, teachDispatch, cancelRequest, openRequest } =
        parseChatResponseTags(responseText);
      responseText = cleanedText;
      const route = cancelRequest
        ? "cancel"
        : openRequest
          ? "open"
          : teachDispatch
            ? "teach"
            : "normal";
      traceAgentEvent("routing.parsed", {
        ...baseCorrelation,
        rawResponse: turnResult.text,
        cleanedReply: cleanedText,
        route,
        teachTopic: teachDispatch?.topicText,
        cancelTopic: cancelRequest?.topicSlug,
        openTopic: openRequest?.topicSlug,
      });
      await handleCancelLessonBuildRequest(cancelRequest);
      handleOpenLessonRequest(openRequest, baseCorrelation);
      if (teachDispatch) {
        const topicWorkspaceDirectory = workspacePath(slugifyTopicName(teachDispatch.topicText));
        if (missionFileExists(topicWorkspaceDirectory)) {
          // Mission already captured: a minutes-long lesson build never blocks the chat.
          void dispatchTeachInstructions({
            backend: request.backend,
            model: request.model,
            topicText: teachDispatch.topicText,
            instructions: teachDispatch.instructions,
            traceId,
            parentTurnId: request.id,
          });
        } else {
          // No mission yet: run the teach skill's own mission interview over voice.
          try {
            // The sync interview turn takes tens of seconds; speak the chat ack now so
            // the user is not left in silence until the first interview question.
            if (responseText.trim().length > 0) {
              traceAgentEvent("response.emitted", {
                ...baseCorrelation,
                channel: "speak",
                text: responseText,
              });
              emitEvent({ id: request.id, type: "speak", text: responseText, ...baseCorrelation });
              responseText = "";
            }
            const interviewId = `interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const interviewStart = await startInterview({
              backend: request.backend,
              model: request.model,
              effort: request.effort,
              topicText: teachDispatch.topicText,
              instructions: teachDispatch.instructions,
              requestId: request.id,
              onStatus,
              traceId,
              interviewId,
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
                  topicText: teachDispatch.topicText,
                  lessonCountAtInterviewStart: interviewStart.lessonCountBeforeInterview,
                  interviewId,
                  parentTurnId: request.id,
                  traceId,
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
              workspaceId: slugifyTopicName(teachDispatch.topicText),
              topicName: teachDispatch.topicText,
              message: String(interviewError?.message ?? interviewError),
            });
          }
        }
      }

      // A first mission-interview reply is appended above after the original
      // chat reply was parsed. Strip any accidental CANCEL or OPEN tag from
      // that newly added spoken text too, so every response stays protocol-clean.
      const finalCancelTagResult = parseCancelTag(responseText);
      const finalOpenTagResult = parseOpenTag(finalCancelTagResult.cleanedText);
      responseText = finalOpenTagResult.cleanedText;
      await handleCancelLessonBuildRequest(finalCancelTagResult.cancelRequest);
      handleOpenLessonRequest(finalOpenTagResult.openRequest, baseCorrelation);
    }

    traceAgentEvent("response.emitted", {
      ...baseCorrelation,
      channel: "result",
      text: responseText,
    });
    emitEvent({
      id: request.id,
      type: "result",
      text: responseText,
      sessionId: turnResult.sessionId ?? null,
      durationMs: turnResult.durationMs ?? null,
      ...baseCorrelation,
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
      traceAgentEvent("cancel.requested", {
        traceId: request.traceId ?? request.targetId,
        turnId: request.targetId,
        targetId: request.targetId,
      });
      const wasCancelled =
        (await cancelClaudeTurn(request.targetId)) ||
        (await cancelCodexTurn(request.targetId));
      if (!wasCancelled && request.targetId) {
        cancelledChatRequestIds.add(request.targetId);
      }
      traceAgentEvent("cancel.result", {
        traceId: request.traceId ?? request.targetId,
        turnId: request.targetId,
        targetId: request.targetId,
        cancelled: wasCancelled,
      });
      emitEvent({ id: request.id, type: "result", cancelled: wasCancelled });
      break;
    }

    case "agentTrace":
      traceAgentEvent(request.event ?? "presentation.unknown", {
        traceId: request.traceId,
        turnId: request.turnId,
        agentRole: request.agentRole ?? "chat",
        text: request.text,
        pointX: request.pointX,
        pointY: request.pointY,
        pointLabel: request.pointLabel,
        screenNumber: request.screenNumber,
        message: request.message,
      });
      break;

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
    traceId: pendingDispatch.traceId,
    parentTurnId: pendingDispatch.parentTurnId,
    interviewId: pendingDispatch.interviewId,
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
    traceAgentEvent(errorCode === "cancelled" ? "agent.cancelled" : "agent.failed", {
      traceId: request.traceId ?? request.id,
      turnId: request.id,
      agentRole: "chat",
      backend: requestError?.clickyBackend ?? request.backend,
      message: String(requestError?.message ?? requestError),
    });
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
