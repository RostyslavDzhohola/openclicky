# Clicky Brain Sidecar

A small Node.js process that gives Clicky its brain using the subscriptions you
already pay for — no API keys, no proxy server. It hosts:

- the **Claude Agent SDK** — runs on your `claude` CLI login (Claude Pro/Max)
- the **OpenAI Codex SDK** — runs on your `codex login` (ChatGPT plan)

The macOS app spawns this process automatically (installing it into
`~/Library/Application Support/OpenClicky/sidecar/` on first run) and talks to it
over stdin/stdout NDJSON — one JSON object per line. You never need to run it
manually, but you can.

## Requirements

- Node.js 18+ (the app probes Homebrew, nvm, volta, and system paths)
- `claude` and/or `codex` installed and signed in (`claude` / `codex login` in
  a terminal, once)

## How conversations work

Every learning topic is a folder under `~/Documents/OpenClicky Lessons/`. Each
folder is a completely vanilla [teach-skill](https://github.com/mattpocock/skills)
workspace — `MISSION.md`, `RESOURCES.md`, `lessons/`, `learning-records/` — plus
one Clicky bookkeeping file, `.clicky.json`, that stores the Claude session id
and Codex thread id so conversations survive restarts. Because the state is
just files and the unmodified published skill, you can open any topic folder in
plain terminal Claude Code or Codex and continue exactly where Clicky left off.

The teach skill itself is installed once via the real installer
(`npx skills add mattpocock/skills --skill teach`) into a template directory,
then file-copied into each new workspace. Skill files are never modified.

## Auth notes (please read)

- **Codex**: reusing your ChatGPT-plan login for local tooling is an
  officially supported flow.
- **Claude**: the sidecar deliberately strips `ANTHROPIC_API_KEY` from its
  environment so the Claude Code runtime falls back to your own CLI login.
  Anthropic's Agent SDK terms discourage third-party products from riding
  claude.ai logins, so treat this as a personal-use experiment. The sanctioned
  path is a real API key: set it in the app (stored in UserDefaults as
  `clickyAnthropicAPIKey`) and the sidecar will bill your Anthropic API account
  instead.

## Testing from the terminal

The drive harness speaks the exact same NDJSON protocol as the app. By default
it sandboxes all state into `$TMPDIR/clicky-drive-*`; add `--real` to use your
real lessons folder.

```bash
npm install

npm run drive -- --backend claude --image ../codex-add-project.png   # chat turn with a screenshot
npm run drive -- --backend codex --image ../codex-add-project.png
npm run drive:auth                                                   # login detection for both backends
npm run drive:resume -- --backend claude                             # context survives a sidecar restart
npm run drive:teach -- --backend claude --topic "css flexbox"        # full lesson generation (minutes)
npm run drive:workspaces                                             # workspace creation + listing
npm run drive:split -- --backend codex                               # chat plane: TEACH dispatch + idle reset (minutes)

npm test                                                             # fast unit tests (no model calls)
```

The chat plane's inactivity reset defaults to 10 minutes; the drive sandbox
shortens it to 3 seconds via `CLICKY_CHAT_IDLE_MS` so `drive:split` can prove
the ephemeral session forgets. Each drive run gets fresh `mkdtemp` state dirs —
stateful modes are only repeatable on a clean lessons root.

Note: if you `npm install` here for terminal testing, this `node_modules` gets
copied into dev app bundles by Xcode's synchronized folder (harmless, just
bigger builds). `npm run clean` removes it; the app always runs its own
`npm ci` copy from Application Support.

## Protocol

Requests (stdin): `chat`, `oneShot`, `createWorkspace`, `listWorkspaces`,
`authStatus`, `cancel`, `shutdown` — every request carries a unique `id`.

Events (stdout): `ready`, `status` (per-turn progress), `result`, `error`
(codes: `auth_required`, `skill_install_failed`, `workspace_missing`,
`cancelled`, `node_backend_crash`, `internal`), `lessonCreated`
(with `openedByAgent` so exactly one browser tab opens), `teachError`
(a dispatched background lesson failed — skill install or teach turn), `log`.

Diagnostics go to stderr; stdout is protocol-only.
