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
  ensureGeneralWorkspaceExists,
  listWorkspaces,
  workspaceExists,
  GENERAL_WORKSPACE_ID,
} = await import("./src/workspaces.mjs");
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

async function handleChatRequest(request) {
  const workspaceId = request.workspaceId ?? GENERAL_WORKSPACE_ID;
  if (!workspaceExists(workspaceId)) {
    emitError(request.id, "workspace_missing", `workspace "${workspaceId}" does not exist`);
    return;
  }

  watchWorkspaceLessons(workspaceId, request.backend);

  const onStatus = (statusUpdate) => {
    emitEvent({ id: request.id, type: "status", ...statusUpdate });
  };

  const chatTurnArguments = {
    requestId: request.id,
    workspaceId,
    model: request.model,
    effort: request.effort,
    text: request.text ?? "",
    images: request.images ?? [],
    teachIntent: request.teachIntent === true,
    onStatus,
  };

  const turnResult =
    request.backend === "codex"
      ? await runCodexChatTurn(chatTurnArguments)
      : await runClaudeChatTurn(chatTurnArguments);

  emitEvent({
    id: request.id,
    type: "result",
    text: turnResult.text,
    sessionId: turnResult.sessionId ?? null,
    durationMs: turnResult.durationMs ?? null,
  });
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

ensureGeneralWorkspaceExists();

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
});
