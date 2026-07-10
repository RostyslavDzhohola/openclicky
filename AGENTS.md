# Clicky - Agent Instructions

<!-- This is the single source of truth for all AI coding agents. CLAUDE.md is a symlink to this file. -->
<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md — supported by Claude Code, Cursor, Copilot, Gemini CLI, and others. -->

## Overview

macOS menu bar companion app. Lives entirely in the macOS status bar (no dock icon, no main window). Clicking the menu bar icon opens a custom floating panel with companion voice controls. Uses push-to-talk (ctrl+option) to capture voice input, transcribes it locally via Apple Speech, and sends the transcript + a screenshot of the user's screen to a local Node "brain sidecar" that hosts the Claude Agent SDK and the OpenAI Codex SDK on the user's existing subscription logins. Replies are spoken via local AVSpeechSynthesizer TTS. A blue cursor overlay can fly to and point at UI elements the brain references on any connected monitor. Saying "teach me X" creates a persistent learning workspace powered by Matt Pocock's teach skill, with interactive HTML lessons that open in the browser.

No API keys and no proxy server are required — the brains run on the user's own `claude` / `codex login` sessions. The original Cloudflare Worker remains in the tree as an optional legacy path.

## Architecture

- **App Type**: Menu bar-only (`LSUIElement=true`), no dock icon or main window
- **Framework**: SwiftUI (macOS native) with AppKit bridging for menu bar panel and cursor overlay
- **Pattern**: MVVM with `@StateObject` / `@Published` state management
- **AI Brain**: Node.js sidecar (`leanring-buddy/sidecar/`) hosting the Claude Agent SDK (Claude Pro/Max login) and OpenAI Codex SDK (ChatGPT-plan login). Two planes: every voice turn runs in a hidden ephemeral chat workspace (`.chat` under the lessons root) that resets on app restart and after ~10 idle minutes (`CLICKY_CHAT_IDLE_MS`); topic workspaces keep one persistent session/thread per backend with ids in `.clicky.json` so lesson context survives restarts. Backend switchable in the panel.
- **Speech-to-Text**: Apple Speech on-device (default). AssemblyAI streaming and OpenAI upload providers remain selectable via the `VoiceTranscriptionProvider` Info.plist key.
- **Text-to-Speech**: `AVSpeechSynthesizer` local voice (default) behind the `CompanionTTSClient` protocol; `ElevenLabsTTSClient` conforms too for the legacy hosted path.
- **Stateful Learning**: the unmodified teach skill (installed once via `npx skills` into a template, file-copied per workspace) runs in per-topic folders under `~/Documents/OpenClicky Lessons/`. The user never talks directly into a topic session except during a new topic's mission interview (see Teach Intent) — otherwise topics are driven only by TEACH dispatches from the chat plane. A chokidar watcher emits `lessonCreated` events (the app opens the lesson HTML unless the agent already did — `openedByAgent` dedupe) and regenerates a static `index.html` dashboard at the lessons root; the panel's "Lessons" button opens it.
- **Screen Capture**: ScreenCaptureKit (macOS 14.2+), multi-monitor support. Captures are written to per-turn temp files (`ScreenshotFileStore`) so both SDKs can read them.
- **Voice Input**: Push-to-talk via `AVAudioEngine` + pluggable transcription-provider layer. System-wide keyboard shortcut via listen-only CGEvent tap.
- **Element Pointing**: the brain embeds `[POINT:x,y:label:screenN]` tags in responses. The overlay parses these, maps coordinates to the correct monitor, and animates the blue cursor along a bezier arc to the target.
- **Teach Intent**: every chat turn carries a fresh topic roster (name/slug/lesson count) read from disk; the chat agent routes learning intents by emitting a trailing `[TEACH:topic-slug:instructions]` tag. For a topic that already has a `MISSION.md`, the sidecar strips the tag, speaks the remainder, and dispatches the instructions asynchronously to the topic's persistent teach session at a deep reasoning tier (codex `xhigh`, claude `high`), instructed to ground the lesson with web search; the chat plane keeps the panel's thinking setting. For a topic without a `MISSION.md` (brand-new, or a pre-feature topic whose mission was never captured — it interviews once on its next teach request), the sidecar instead relays the teach skill's own mission interview over voice: the first teach turn runs synchronously inside the chat request (its first interview question is spoken as part of the reply) and subsequent chat-plane voice turns route into the topic session — no roster injection, panel effort, backend pinned — until the skill writes `MISSION.md`, the deterministic completion signal that triggers the deep-tier lesson build dispatch (skipped if the model already built a lesson mid-interview). Safety valves: an 8-turn cap that tells the skill to wrap up, and a 10-minute silence expiry (`CLICKY_INTERVIEW_IDLE_MS`) that abandons the interview; interview turns are never recorded in the durable dispatch queue, so a mid-interview crash self-heals by re-asking. Failures surface as a spoken `teachError` event.
- **Concurrency**: `@MainActor` isolation, async/await throughout
- **Analytics**: PostHog via `ClickyAnalytics.swift`

### Brain Sidecar (Node.js)

The app spawns `node index.mjs` from `~/Library/Application Support/OpenClicky/sidecar/` (auto-installed from bundled resources; SHA-256 hash check + `npm ci` on change) and speaks NDJSON over stdin/stdout — one JSON object per line, stderr reserved for diagnostics.

| Request | Purpose |
|---------|---------|
| `chat` | one voice turn: text + screenshot file paths + backend. Runs on the ephemeral chat plane; an explicit non-general `workspaceId` (+ `teachIntent`) is a legacy path kept for the drive harness |
| `oneShot` | stateless turn with a custom system prompt (onboarding demo) |
| `createWorkspace` / `listWorkspaces` | learning-topic folder management |
| `authStatus` | login detection for both backends + teach-skill install state |
| `cancel` / `shutdown` | interrupt an in-flight turn / graceful exit |

Events: `ready` (carries `lessonsRoot` + `dashboardPath`), `status` (per-turn progress), `result`, `error` (codes: `auth_required`, `skill_install_failed`, `workspace_missing`, `cancelled`, `node_backend_crash`, `internal`), `speak` (a line the app voices immediately — the course-setup ack before the synchronous interview turn, and the finished-build announcement after a background dispatch), `teachBuildStarted` (a background lesson build began — drives the panel's "building your lesson" indicator until `lessonCreated`/`teachError`), `lessonCreated`, `teachError` (background lesson dispatch failed — spoken by the app), `log`.

Auth hygiene: the sidecar strips `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CODEX_API_KEY` from its environment so both SDKs fall back to subscription logins. The sanctioned Anthropic API-key path is opt-in via the `clickyAnthropicAPIKey` UserDefaults key (forwarded as `CLICKY_ANTHROPIC_API_KEY`).

The sidecar is fully testable from the terminal without building the app: see `leanring-buddy/sidecar/README.md` (`npm run drive*` harness).

### API Proxy (Cloudflare Worker — optional legacy)

`worker/src/index.ts` still proxies `/chat` (Anthropic), `/tts` (ElevenLabs), and `/transcribe-token` (AssemblyAI) for anyone who prefers the hosted-API setup, but nothing in the default app path uses it.

### Key Architecture Decisions

**Menu Bar Panel Pattern**: The companion panel uses `NSStatusItem` for the menu bar icon and a custom borderless `NSPanel` for the floating control panel. This gives full control over appearance (dark, rounded corners, custom shadow) and avoids the standard macOS menu/popover chrome. The panel is non-activating so it doesn't steal focus. A global event monitor auto-dismisses it on outside clicks.

**Cursor Overlay**: A full-screen transparent `NSPanel` hosts the blue cursor companion. It's non-activating, joins all Spaces, and never steals focus. The cursor position, response text, waveform, and pointing animations all render in this overlay via SwiftUI through `NSHostingView`.

**Global Push-To-Talk Shortcut**: Background push-to-talk uses a listen-only `CGEvent` tap instead of an AppKit global monitor so modifier-based shortcuts like `ctrl + option` are detected more reliably while the app is running in the background.

**Shared URLSession for AssemblyAI**: A single long-lived `URLSession` is shared across all AssemblyAI streaming sessions (owned by the provider, not the session). Creating and invalidating a URLSession per session corrupts the OS connection pool and causes "Socket is not connected" errors after a few rapid reconnections.

**Transient Cursor Mode**: When "Show Clicky" is off, pressing the hotkey fades in the cursor overlay for the duration of the interaction (recording → response → TTS → optional pointing), then fades it out automatically after 1 second of inactivity.

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `leanring_buddyApp.swift` | ~97 | Menu bar app entry point. Uses `@NSApplicationDelegateAdaptor` with `CompanionAppDelegate` which creates `MenuBarPanelManager`, starts `CompanionManager`, and starts/stops the brain sidecar with the app lifecycle. No main window — the app lives entirely in the status bar. |
| `CompanionManager.swift` | ~999 | Central state machine. Owns dictation, shortcut monitoring, screen capture, the brain provider, TTS, and overlay management. Tracks voice state (idle/listening/processing/responding), backend/model selection, microphone selection passthrough, and cursor visibility. Coordinates push-to-talk → screenshot → brain → TTS → pointing, parses `[POINT:...]` tags (teach routing lives in the sidecar now), enumerates lesson topics/files for the panel picker, opens lessons and the dashboard, speaks `teachError` failures, and speaks a one-time reassurance on long turns. |
| `SidecarProcessManager.swift` | ~1063 | Brain sidecar supervisor. Discovers Node 18+ (Homebrew/nvm/volta/system + login-shell fallback), installs the bundled sidecar into Application Support (hash-checked `npm ci`), spawns it, speaks NDJSON via continuation-per-request routing, publishes the lessons-dashboard path from the ready event, surfaces `teachError` via callback, and auto-restarts on crash with backoff. |
| `CompanionBrainProvider.swift` | ~136 | Brain abstraction used by `CompanionManager`. `SidecarBrainProvider` writes screenshots to disk, sends chat/one-shot requests (no workspace routing — the sidecar owns it), maps sidecar status events to `BrainStatus`, cancels on task cancellation, and enforces 3-minute inactivity / 10-minute total watchdogs. |
| `AppleTTSClient.swift` | ~115 | `CompanionTTSClient` protocol + local `AVSpeechSynthesizer` implementation (returns when speech starts, prefers premium/enhanced en-US voices). `ElevenLabsTTSClient` conforms for the legacy path. |
| `ScreenshotFileStore.swift` | ~59 | Per-turn screenshot files under Application Support for sidecar consumption; per-turn cleanup and stale-directory sweep at launch. |
| `MenuBarPanelManager.swift` | ~243 | NSStatusItem + custom NSPanel lifecycle. Creates the menu bar icon, manages the floating companion panel (show/hide/position), installs click-outside-to-dismiss monitor. |
| `CompanionPanelView.swift` | ~1210 | SwiftUI panel content for the menu bar dropdown. Shows companion status, push-to-talk instructions, brain backend picker (Claude/Codex), per-backend sign-in status, sidecar health, model/thinking pickers, a microphone picker (pins a capture device so AirPods auto-routing can be overridden), a "Lessons" menu that opens individual lessons or the static dashboard (topics are managed entirely by voice), permissions UI, DM feedback button, and quit button. Dark aesthetic using `DS` design system. |
| `OverlayWindow.swift` | ~881 | Full-screen transparent overlay hosting the blue cursor, response text, waveform, and spinner. Handles cursor animation, element pointing with bezier arcs, multi-monitor coordinate mapping, and fade-out transitions. |
| `CompanionResponseOverlay.swift` | ~217 | SwiftUI view for the response text bubble and waveform displayed next to the cursor in the overlay. |
| `CompanionScreenCaptureUtility.swift` | ~132 | Multi-monitor screenshot capture using ScreenCaptureKit. Returns labeled image data for each connected display. |
| `BuddyDictationManager.swift` | ~1063 | Push-to-talk voice pipeline. Handles microphone capture via `AVAudioEngine`, capture-device enumeration and per-session input pinning via CoreAudio (with default-restore when the pin clears or vanishes), provider-aware permission checks, keyboard/button dictation sessions, transcript finalization, shortcut parsing, contextual keyterms, and live audio-level reporting for waveform feedback. |
| `BuddyTranscriptionProvider.swift` | ~100 | Protocol surface and provider factory for voice transcription backends. Resolves provider based on `VoiceTranscriptionProvider` in Info.plist — AssemblyAI, OpenAI, or Apple Speech. |
| `AssemblyAIStreamingTranscriptionProvider.swift` | ~478 | Streaming transcription provider. Fetches temp tokens from the Cloudflare Worker, opens an AssemblyAI v3 websocket, streams PCM16 audio, tracks turn-based transcripts, and delivers finalized text on key-up. Shares a single URLSession across all sessions. |
| `OpenAIAudioTranscriptionProvider.swift` | ~317 | Upload-based transcription provider. Buffers push-to-talk audio locally, uploads as WAV on release, returns finalized transcript. |
| `AppleSpeechTranscriptionProvider.swift` | ~147 | Local fallback transcription provider backed by Apple's Speech framework. |
| `BuddyAudioConversionSupport.swift` | ~108 | Audio conversion helpers. Converts live mic buffers to PCM16 mono audio and builds WAV payloads for upload-based providers. |
| `GlobalPushToTalkShortcutMonitor.swift` | ~132 | System-wide push-to-talk monitor. Owns the listen-only `CGEvent` tap and publishes press/release transitions. |
| `OpenAIAPI.swift` | ~142 | OpenAI GPT vision API client (legacy, unused by the default path). |
| `ElevenLabsTTSClient.swift` | ~81 | ElevenLabs TTS client (legacy path). Sends text to the Worker proxy, plays back audio via `AVAudioPlayer`. Conforms to `CompanionTTSClient`. |
| `ElementLocationDetector.swift` | ~335 | Detects UI element locations in screenshots for cursor pointing. |
| `DesignSystem.swift` | ~880 | Design system tokens — colors, corner radii, shared styles. All UI references `DS.Colors`, `DS.CornerRadius`, etc. |
| `ClickyAnalytics.swift` | ~121 | PostHog analytics integration for usage tracking. |
| `WindowPositionManager.swift` | ~262 | Window placement logic, Screen Recording permission flow, and accessibility permission helpers. |
| `AppBundleConfiguration.swift` | ~28 | Runtime configuration reader for keys stored in the app bundle Info.plist. |
| `worker/src/index.ts` | ~142 | Cloudflare Worker proxy (optional legacy). Three routes: `/chat` (Claude), `/tts` (ElevenLabs), `/transcribe-token` (AssemblyAI temp token). |
| `sidecar/index.mjs` | ~574 | Sidecar entry point: stdin NDJSON dispatch loop, chat-plane routing (roster injection, TEACH tag strip, idle reset), mission-interview state machine (sync first teach turn, routed voice turns, MISSION.md completion check, expiry/turn-cap valves), async lesson-build dispatch, startup chat/dashboard/watcher bootstrap, teach-template bootstrap, shutdown on stdin EOF. |
| `sidecar/src/teachInterview.mjs` | ~72 | Pure interview-mode pieces: MISSION.md existence check (the interview-complete signal), single-interview tracker with the 8-turn cap, and the preamble/wrap-up/build-dispatch prompt constants. |
| `sidecar/src/teachTag.mjs` | ~33 | Parser for the extended `[TEACH:slug:instructions]` tag: strips all teach tags from spoken text, dispatches at most the first well-formed one, defaults missing instructions. |
| `sidecar/src/topicRoster.mjs` | ~31 | Builds the per-turn `[topic roster]` block (name/slug/lesson count per topic, general and dot-dirs excluded) appended to every chat-plane turn. |
| `sidecar/src/lessonsDashboard.mjs` | ~86 | Static `index.html` generator at the lessons root: every topic's lessons as plain links, latest highlighted, no server or JS. Regenerated at startup, on workspace creation, and on every `lessonCreated`. |
| `sidecar/src/claudeBackend.mjs` | ~417 | Claude Agent SDK backend. Persistent streaming-input `query()` session per workspace, base64 image blocks, session resume, `/teach` invocation with SKILL.md fallback, interrupt-on-cancel. |
| `sidecar/src/codexBackend.mjs` | ~278 | Codex SDK backend. Persistent thread per workspace, `local_image` inputs, thread resume, `$teach` invocation, AbortSignal cancellation. |
| `sidecar/src/workspaces.mjs` | ~209 | Learning-workspace management: `~/Documents/OpenClicky Lessons/` folders, slugs, `.clicky.json` session bookkeeping, AGENTS.md companion rules for Codex, plus the hidden `.chat` ephemeral workspace (created at startup, session ids cleared on every launch). |
| `sidecar/src/teachSkill.mjs` | ~136 | Installs the unmodified teach skill once via `npx skills` into a template, then file-copies it into each workspace (both `.agents/` and `.claude/` layouts, matching the vanilla installer). |
| `sidecar/src/companionRules.mjs` | ~91 | Single source of truth for the spoken-companion persona + `[POINT:...]`/`[TEACH:slug:instructions]` tag protocols, roster grounding, and the ask-before-creating-a-topic rule. Appended to Claude's system-prompt preset; written as AGENTS.md for Codex (full chat notes in `.chat`, slim notes in topic workspaces). |
| `sidecar/src/lessonWatcher.mjs` | ~79 | Chokidar watcher on workspace roots; regenerates the lessons dashboard and emits `lessonCreated` with `openedByAgent` computed from the turn's shell commands. |
| `sidecar/src/auth.mjs` / `env.mjs` / `protocol.mjs` | ~150 | Login detection (Keychain/credentials files), subscription-auth env hygiene, NDJSON helpers. |
| `sidecar/test/drive.mjs` | ~558 | Terminal test harness speaking the real protocol: chat/oneshot/auth/workspaces/teach/resume/split/interview drives against live subscriptions, fresh temp dirs per run. Unit tests live in `test/unit/` (`npm test`). |

## Build & Run

```bash
# Prerequisites: Node.js 18+, and `claude` and/or `codex login` signed in once in a terminal.

# Open in Xcode
open leanring-buddy.xcodeproj

# Select the leanring-buddy scheme, set signing team, Cmd+R to build and run
# First launch installs sidecar dependencies (~30s); the panel shows progress.

# Known non-blocking warnings: Swift 6 concurrency warnings,
# deprecated onChange warning in OverlayWindow.swift. Do NOT attempt to fix these.
```

**Do NOT run `xcodebuild` from the terminal** — it invalidates TCC (Transparency, Consent, and Control) permissions and the app will need to re-request screen recording, accessibility, etc.

**Sidecar changes are testable without Xcode** — the drive harness speaks the app's exact protocol from the terminal (state sandboxed to `$TMPDIR` by default):

```bash
cd leanring-buddy/sidecar && npm install
npm run drive -- --backend claude --image ../codex-add-project.png
npm run drive:teach -- --backend codex --topic "css flexbox"
```

**Agents: verify with `npm test` only.** The `npm run drive*` commands run live turns against real Claude/ChatGPT subscriptions — teach drives build entire lessons and take many minutes. Agents must NOT run them; document which drive would verify a change and leave running it to the user.

Dev override: set the `clickySidecarDevPath` UserDefaults key to the repo's `leanring-buddy/sidecar` path to make the app spawn straight from the repo instead of the Application Support install.

## Cloudflare Worker (optional legacy)

```bash
cd worker
npm install

# Add secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY

# Deploy
npx wrangler deploy

# Local dev (create worker/.dev.vars with your keys)
npx wrangler dev
```

## Code Style & Conventions

### Variable and Method Naming

IMPORTANT: Follow these naming rules strictly. Clarity is the top priority.

- Be as clear and specific with variable and method names as possible
- **Optimize for clarity over concision.** A developer with zero context on the codebase should immediately understand what a variable or method does just from reading its name
- Use longer names when it improves clarity. Do NOT use single-character variable names
- Example: use `originalQuestionLastAnsweredDate` instead of `originalAnswered`
- When passing props or arguments to functions, keep the same names as the original variable. Do not shorten or abbreviate parameter names. If you have `currentCardData`, pass it as `currentCardData`, not `card` or `cardData`

### Code Clarity

- **Clear is better than clever.** Do not write functionality in fewer lines if it makes the code harder to understand
- Write more lines of code if additional lines improve readability and comprehension
- Make things so clear that someone with zero context would completely understand the variable names, method names, what things do, and why they exist
- When a variable or method name alone cannot fully explain something, add a comment explaining what is happening and why

### Swift/SwiftUI Conventions

- Use SwiftUI for all UI unless a feature is only supported in AppKit (e.g., `NSPanel` for floating windows)
- All UI state updates must be on `@MainActor`
- Use async/await for all asynchronous operations
- Comments should explain "why" not just "what", especially for non-obvious AppKit bridging
- AppKit `NSPanel`/`NSWindow` bridged into SwiftUI via `NSHostingView`
- All buttons must show a pointer cursor on hover
- For any interactive element, explicitly think through its hover behavior (cursor, visual feedback, and whether hover should communicate clickability)

### Do NOT

- Do not add features, refactor code, or make "improvements" beyond what was asked
- Do not add docstrings, comments, or type annotations to code you did not change
- Do not try to fix the known non-blocking warnings (Swift 6 concurrency, deprecated onChange)
- Do not rename the project directory or scheme (the "leanring" typo is intentional/legacy)
- Do not run `xcodebuild` from the terminal — it invalidates TCC permissions
- Do not run live sidecar drives (`npm run drive*`) — they are slow and burn real subscription quota. Verify sidecar changes with `npm test` (unit tests) and let the user run the drives

## Git Workflow

- Branch naming: `feature/description` or `fix/description`
- Commit messages: imperative mood, concise, explain the "why" not the "what"
- Do not force-push to main

## Self-Update Instructions

<!-- AI agents: follow these instructions to keep this file accurate. -->

When you make changes to this project that affect the information in this file, update this file to reflect those changes. Specifically:

1. **New files**: Add new source files to the "Key Files" table with their purpose and approximate line count
2. **Deleted files**: Remove entries for files that no longer exist
3. **Architecture changes**: Update the architecture section if you introduce new patterns, frameworks, or significant structural changes
4. **Build changes**: Update build commands if the build process changes
5. **New conventions**: If the user establishes a new coding convention during a session, add it to the appropriate conventions section
6. **Line count drift**: If a file's line count changes significantly (>50 lines), update the approximate count in the Key Files table

Do NOT update this file for minor edits, bug fixes, or changes that don't affect the documented architecture or conventions.
