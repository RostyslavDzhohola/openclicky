// Isolated Codex home directory.
//
// Codex sessions must load only app-controlled configuration: the user's
// global ~/.codex/config.toml and ~/.codex/AGENTS.md must not leak into lesson
// or chat turns. A trace audit caught personal AGENTS.md rules injected into
// lesson workspaces. Login remains shared through a symlinked auth.json, which
// is safe because codex 0.142.5 rewrites auth.json in place through that
// symlink (verified in codex-rs/login/src/auth/storage.rs at rust-v0.142.5),
// and Codex's guarded reload already coordinates concurrent instances sharing
// the file.

import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applicationSupportDirectory } from "./appSupport.mjs";
import { emitLog } from "./protocol.mjs";

export function ensureIsolatedCodexHome() {
  const isolatedCodexHomeDirectory = join(applicationSupportDirectory(), "codex-home");
  const authSymlinkPath = join(isolatedCodexHomeDirectory, "auth.json");
  const realAuthPath = join(homedir(), ".codex", "auth.json");

  try {
    // The Codex CLI refuses to start unless CODEX_HOME already exists.
    mkdirSync(isolatedCodexHomeDirectory, { recursive: true });

    let existingAuthPathStats = null;
    try {
      existingAuthPathStats = lstatSync(authSymlinkPath);
    } catch (authPathError) {
      if (authPathError?.code !== "ENOENT") {
        throw authPathError;
      }
    }

    if (existingAuthPathStats) {
      const isCorrectSharedAuthSymlink =
        existingAuthPathStats.isSymbolicLink() &&
        readlinkSync(authSymlinkPath) === realAuthPath;
      if (isCorrectSharedAuthSymlink) {
        return isolatedCodexHomeDirectory;
      }

      // A future CLI could switch to atomic replacement, silently leaving a
      // copied login behind. Heal it so login continues to follow the user's
      // subscription session instead of diverging from it.
      unlinkSync(authSymlinkPath);
      emitLog(
        "warn",
        "replaced non-shared codex-home/auth.json so it again follows ~/.codex/auth.json"
      );
    }

    // A dangling link is intentional: it becomes valid after the user signs
    // in with `codex login`, without forcing the sidecar to manage credentials.
    symlinkSync(realAuthPath, authSymlinkPath);
    return isolatedCodexHomeDirectory;
  } catch (codexHomeError) {
    // Falling back to the default home can leak configuration, but keeps the
    // voice backend available when local filesystem state is unexpectedly bad.
    emitLog(
      "warn",
      `could not isolate Codex home; falling back to ~/.codex: ${codexHomeError?.message ?? codexHomeError}`
    );
    return null;
  }
}

export function buildCodexChildEnvironment() {
  const isolatedCodexHomeDirectory = ensureIsolatedCodexHome();
  // CodexOptions.env replaces the child environment wholesale. env.mjs has
  // already removed API keys, while spreading preserves PATH and HOME needed
  // for the CLI to launch and share the user's ChatGPT-plan login.
  const codexChildEnvironment = { ...process.env };
  if (isolatedCodexHomeDirectory !== null) {
    codexChildEnvironment.CODEX_HOME = isolatedCodexHomeDirectory;
  } else {
    // Do not retain an inherited override when isolation failed: null means
    // deliberately fall back to Codex's normal ~/.codex resolution.
    delete codexChildEnvironment.CODEX_HOME;
  }
  return codexChildEnvironment;
}
