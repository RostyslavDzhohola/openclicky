// Environment hygiene for the SDK child processes.
//
// Both SDKs spawn CLI binaries that decide their auth mode from environment
// variables. To guarantee subscription auth is used:
//   - ANTHROPIC_API_KEY must be ABSENT so the Claude Code runtime falls back
//     to the user's `claude` CLI login (Claude Pro/Max). The sanctioned
//     API-key path is opt-in: the app forwards CLICKY_ANTHROPIC_API_KEY,
//     which we map back to ANTHROPIC_API_KEY here.
//   - OPENAI_API_KEY / CODEX_API_KEY must be ABSENT so the Codex CLI uses
//     the ChatGPT-plan login cached in ~/.codex/auth.json.
//
// The sidecar sanitizes its OWN process env at startup (the SDKs inherit it
// when spawning their CLIs), which covers both launch paths: spawned by the
// app with a minimal env, or run from a developer terminal with a fully
// populated shell env.

/** The opt-in API key forwarded by the app, captured before sanitizing. */
let optInAnthropicAPIKey = null;

export function sanitizeProcessEnvForSubscriptionAuth() {
  optInAnthropicAPIKey = process.env.CLICKY_ANTHROPIC_API_KEY ?? null;

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLICKY_ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;

  if (optInAnthropicAPIKey) {
    // Sanctioned path: the user explicitly configured an Anthropic API key
    // in the app, so Claude turns bill to their API account instead of
    // riding the claude.ai subscription login.
    process.env.ANTHROPIC_API_KEY = optInAnthropicAPIKey;
  }
}

/** Whether the user opted into API-key billing for Claude. */
export function isAnthropicAPIKeyConfigured() {
  return optInAnthropicAPIKey !== null;
}
