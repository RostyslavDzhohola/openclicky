// Teach-skill installation.
//
// Matt Pocock's teach skill ships with the app as a checked-in vanilla-installer
// snapshot, refreshed deliberately with `npm run refresh-teach-template`. The
// snapshot is the untouched installer output, preserving the unmodified-skill
// principle, while `npx skills` remains a fallback if that bundled copy is
// unavailable. The template is then file-copied into each new workspace.
//
// Layout replicated per workspace (matching the vanilla install exactly):
//   .agents/skills/teach/SKILL.md (+ FORMAT files)  ← read by Codex
//   .claude/skills/teach/SKILL.md (+ FORMAT files)  ← read by Claude Code

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { emitLog } from "./protocol.mjs";

const execFileAsync = promisify(execFile);

const TEACH_INSTALL_TIMEOUT_MS = 180_000;

function applicationSupportDirectory() {
  return (
    process.env.CLICKY_APP_SUPPORT ??
    join(homedir(), "Library", "Application Support", "OpenClicky")
  );
}

function templateDirectory() {
  return join(applicationSupportDirectory(), "teach-template");
}

function templateTeachSkillPath() {
  return join(templateDirectory(), ".agents", "skills", "teach");
}

function bundledTemplateDirectory() {
  const currentModuleDirectory = dirname(fileURLToPath(import.meta.url));
  return join(currentModuleDirectory, "..", "teach-template");
}

/** Remembered install outcome, surfaced to the app via authStatus. */
let installState = { installed: false, message: "not yet bootstrapped" };
let bootstrapInFlight = null;

export function teachSkillInstallState() {
  return installState;
}

async function bootstrapTemplate() {
  if (existsSync(join(templateTeachSkillPath(), "SKILL.md"))) {
    installState = { installed: true, message: "ok" };
    return;
  }

  const bundledTeachTemplateDirectory = bundledTemplateDirectory();
  const bundledTeachSkillPath = join(
    bundledTeachTemplateDirectory,
    ".agents",
    "skills",
    "teach",
    "SKILL.md"
  );
  if (existsSync(bundledTeachSkillPath)) {
    // The app installs its sidecar wholesale, so this snapshot is available
    // alongside index.mjs without requiring first-launch network access.
    mkdirSync(applicationSupportDirectory(), { recursive: true });
    cpSync(bundledTeachTemplateDirectory, templateDirectory(), { recursive: true });
    installState = { installed: true, message: "ok" };
    emitLog("info", "used bundled teach skill template");
    return;
  }

  mkdirSync(templateDirectory(), { recursive: true });
  emitLog("info", "bootstrapping teach skill template via npx skills…");

  try {
    // --copy gives real files (not symlinks into an npx cache) so the
    // template survives being file-copied into workspaces.
    await execFileAsync(
      "npx",
      [
        "-y",
        "skills@latest",
        "add",
        "mattpocock/skills",
        "--skill",
        "teach",
        "--agent",
        "claude-code",
        "--agent",
        "codex",
        "-y",
        "--copy",
      ],
      {
        cwd: templateDirectory(),
        timeout: TEACH_INSTALL_TIMEOUT_MS,
        env: process.env,
      }
    );
  } catch (installError) {
    installState = {
      installed: false,
      message: `npx skills install failed: ${installError?.message ?? installError}`,
    };
    emitLog("warn", installState.message);
    return;
  }

  if (existsSync(join(templateTeachSkillPath(), "SKILL.md"))) {
    installState = { installed: true, message: "ok" };
    emitLog("info", "teach skill template ready");
  } else {
    installState = {
      installed: false,
      message: "npx skills completed but SKILL.md not found in template",
    };
    emitLog("warn", installState.message);
  }
}

/**
 * Ensures the template exists (bootstrapping if needed), then — when a
 * workspace path is given — copies the skill into that workspace.
 * Returns {installed, message} for the workspace (or the template when
 * workspacePath is null).
 */
export async function ensureTeachSkillInstalled(workspacePath) {
  // Serialize bootstrap so concurrent createWorkspace calls don't race npx
  if (!bootstrapInFlight) {
    bootstrapInFlight = bootstrapTemplate().finally(() => {
      // Allow a retry on the next call if bootstrap failed
      if (!installState.installed) {
        bootstrapInFlight = null;
      }
    });
  }
  await bootstrapInFlight;

  if (!installState.installed || workspacePath === null) {
    return installState;
  }

  // The vanilla installer produces a real copy in BOTH agent directories
  // (.agents/skills/teach for Codex, .claude/skills/teach for Claude Code) —
  // replicate that layout exactly.
  for (const agentDirectory of [".agents", ".claude"]) {
    const workspaceTeachPath = join(workspacePath, agentDirectory, "skills", "teach");
    if (!existsSync(join(workspaceTeachPath, "SKILL.md"))) {
      mkdirSync(dirname(workspaceTeachPath), { recursive: true });
      cpSync(templateTeachSkillPath(), workspaceTeachPath, { recursive: true });
    }
  }

  return { installed: true, message: "ok" };
}
