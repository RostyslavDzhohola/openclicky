# OpenClicky — Clicky, powered by the subscriptions you already have

This is a fork of [Farza's Clicky](https://github.com/farzaa/clicky) — the AI
teacher that lives next to your cursor, sees your screen, talks to you, and
points at stuff. It builds as **OpenClicky.app** with its own bundle id, so it
installs, gets permissions, and stores state completely independently from the
real Clicky — you can run both side by side.

![Clicky — an ai buddy that lives on your mac](clicky-demo.gif)

The original needs a Cloudflare Worker and three paid API keys. This fork needs
**none of that**. It runs on the subscriptions you already pay for:

- **Brain**: your Claude Pro/Max subscription (via the Claude Agent SDK) or
  your ChatGPT plan (via the Codex SDK) — switch between them in the panel
- **Voice**: Apple's on-device speech recognition and synthesis — free, local,
  works offline
- **Infra**: none. No Worker, no keys, no server. A tiny Node sidecar runs on
  your Mac.

And it adds the thing Clicky always wanted to be: **a teacher with a memory.**

## Stateful learning with the teach skill

Say *"teach me CSS flexbox"* and Clicky creates a real learning workspace using
[Matt Pocock's teach skill](https://github.com/mattpocock/skills) — the actual
published skill, unmodified. It interviews you by voice about your goals,
writes a `MISSION.md`, researches sources into `RESOURCES.md`, and generates
interactive HTML lessons with quizzes that open in your browser. Come back
tomorrow, ask to review, get quizzed, request the next lesson — it remembers
everything, because everything is files:

```
~/Documents/OpenClicky Lessons/
  css-flexbox/
    MISSION.md            # why you're learning this
    RESOURCES.md          # curated sources
    lessons/0001-*.html   # interactive lessons with quizzes
    learning-records/     # what you've actually understood
    reference/            # growing cheat sheets
```

Each topic folder is a completely vanilla teach-skill workspace. Open one in
plain terminal Claude Code or Codex and continue exactly where Clicky left
off — we verified the output is structurally identical to what the plain CLIs
produce. And because Clicky sees your screen, lessons can be grounded in the
actual tool you're stuck in.

## Setup

Prerequisites:

- macOS 14.2+, Xcode 15+
- Node.js 18+ (`brew install node` works)
- At least one of: [Claude Code](https://code.claude.com) signed in with your
  Claude sub (run `claude` once), or [Codex CLI](https://developers.openai.com/codex)
  signed in with your ChatGPT plan (`codex login`)

Then:

```bash
git clone https://github.com/RostyslavDzhohola/openclicky.git
cd openclicky
open leanring-buddy.xcodeproj
```

In Xcode: select the `leanring-buddy` scheme (yes, the typo is intentional),
set your signing team, hit **Cmd+R**. The app appears in your menu bar. On
first launch it installs the sidecar's dependencies (~30s, one time) — the
panel shows progress. Grant the permissions it asks for (microphone,
accessibility, screen recording) and hold **Ctrl+Option** to talk.

The panel shows your sign-in status for both backends and lets you switch
brains mid-conversation. Each backend keeps its own conversation context per
topic, and context survives app restarts.

## The honest auth note

Reusing your ChatGPT plan through the Codex SDK is an officially supported
flow. On the Claude side, Anthropic's Agent SDK terms discourage third-party
products from offering claude.ai login — so treat the Claude-sub path as a
personal-use experiment on your own machine with your own login. The sanctioned
alternative is an Anthropic API key (set `clickyAnthropicAPIKey` via
`defaults write` and the sidecar bills your API account instead):

```bash
defaults write com.openclicky.app clickyAnthropicAPIKey "sk-ant-..."
```

## Architecture

```
Swift app (menu bar, hotkey, screen capture, cursor overlay, Apple voice)
   │  stdin/stdout NDJSON
   ▼
Node sidecar (auto-installed to ~/Library/Application Support/OpenClicky/)
   ├── Claude Agent SDK — persistent session per topic, your claude login
   ├── Codex SDK        — persistent thread per topic, your codex login
   ├── teach-skill workspaces under ~/Documents/OpenClicky Lessons/
   └── lesson watcher   — opens finished lessons in your browser
```

The push-to-talk pipeline is unchanged from the original: transcript +
multi-monitor screenshots go to the brain, the reply is spoken aloud, and
`[POINT:x,y:label:screenN]` tags fly the blue cursor to UI elements. New:
`[TEACH:topic]` tags create learning workspaces by voice, long lesson turns
get a spoken "on it — this one can take a minute or two", and the sidecar can
be driven headlessly from a terminal for testing (`leanring-buddy/sidecar/README.md`).

The original Cloudflare Worker (`worker/`) and the AssemblyAI/ElevenLabs
clients are still in the tree if you want the hosted-API setup — flip
`VoiceTranscriptionProvider` in Info.plist back to `assemblyai` — but nothing
requires them.

## Project structure

```
leanring-buddy/               # Swift source (the typo stays)
  CompanionManager.swift         # Central state machine
  CompanionPanelView.swift       # Menu bar panel (backend/topic pickers live here)
  SidecarProcessManager.swift    # Spawns + supervises the Node sidecar
  CompanionBrainProvider.swift   # Brain abstraction over the sidecar
  AppleTTSClient.swift           # Local text-to-speech
  OverlayWindow.swift            # Blue cursor overlay
  sidecar/                       # Node sidecar (Agent SDK + Codex SDK + teach)
    test/drive.mjs                  # terminal test harness — no Xcode needed
worker/                       # Original Cloudflare Worker proxy (optional now)
AGENTS.md                     # Full architecture doc (agents read this)
```

## Credits

Clicky is [Farza's](https://x.com/farzatv) creation, MIT licensed — his
original README intro said "go crazy with this repo," so this fork did. The
teach skill is [Matt Pocock's](https://www.aihero.dev/learn-anything-with-my-teach-skill).

OpenClicky — the subscription-brain + stateful-learning spin-off — is built and
maintained by [Rostyslav Dzhohola](https://github.com/RostyslavDzhohola). It's an
experiment in what Clicky becomes when the harness is Claude Code / Codex itself:
a better UI on the agents you already have, free to run, with lessons you keep.
Bugs, ideas, PRs welcome.
