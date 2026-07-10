// Teach-skill installation.
//
// Matt Pocock's teach skill is installed ONCE into a template directory via
// the real `npx skills` installer (so we get the exact published skill,
// never a reimplementation), then file-copied into each new workspace. This
// keeps workspace creation fast, offline-capable after the first run, and
// immune to interactive installer prompts.
//
// Layout replicated per workspace (matching the vanilla install exactly):
//   .agents/skills/teach/SKILL.md (+ FORMAT files)  ← read by Codex
//   .claude/skills/teach/SKILL.md (+ FORMAT files)  ← read by Claude Code

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { applicationSupportDirectory } from "./appSupport.mjs";
import { emitLog } from "./protocol.mjs";

const execFileAsync = promisify(execFile);

const TEACH_INSTALL_TIMEOUT_MS = 180_000;

function templateDirectory() {
  return join(applicationSupportDirectory(), "teach-template");
}

function templateTeachSkillPath() {
  return join(templateDirectory(), ".agents", "skills", "teach");
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
