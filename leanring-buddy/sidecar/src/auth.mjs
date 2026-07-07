// Auth-status detection for both backends.
//
// Claude: the Claude Code runtime stores its OAuth login either in the macOS
// Keychain (item "Claude Code-credentials") or in ~/.claude/.credentials.json.
// An explicitly configured API key also counts as authenticated.
//
// Codex: the ChatGPT-plan login is cached in ~/.codex/auth.json. That file's
// presence is the cheap check; `codex login status` is authoritative but
// slower, so we only use the file check here. Real turns that fail with an
// auth error override this optimistic answer via the auth_required error code.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isAnthropicAPIKeyConfigured } from "./env.mjs";

const execFileAsync = promisify(execFile);

async function isClaudeKeychainCredentialPresent() {
  try {
    await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function checkAuthStatus() {
  const claudeCredentialsFileExists = existsSync(
    join(homedir(), ".claude", ".credentials.json")
  );
  const claudeKeychainPresent = await isClaudeKeychainCredentialPresent();
  const claudeUsesAPIKey = isAnthropicAPIKeyConfigured();

  const codexAuthFileExists = existsSync(join(homedir(), ".codex", "auth.json"));

  return {
    claude: {
      loggedIn: claudeUsesAPIKey || claudeCredentialsFileExists || claudeKeychainPresent,
      method: claudeUsesAPIKey ? "api_key" : "oauth",
    },
    codex: {
      loggedIn: codexAuthFileExists,
      method: "chatgpt_plan",
    },
  };
}
