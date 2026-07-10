# Chat vs. Learning Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate ephemeral voice chat from persistent learning per `docs/superpowers/specs/2026-07-08-chat-vs-learning-split-design.md`, and wire the ignored transcription keyterms into Apple Speech so spoken topic names transcribe reliably.

**Architecture:** Voice turns always run in a hidden ephemeral chat workspace (`.chat` under the lessons root) that resets on restart and after 10 idle minutes. The chat agent routes learning intents by emitting an extended `[TEACH:topic:instructions]` tag; the sidecar strips the tag, speaks the remainder, and dispatches the instructions asynchronously to the topic's persistent teach session. A static `index.html` dashboard at the lessons root replaces the topic picker; the panel gets one "Lessons" button.

**Tech Stack:** Node 18+ sidecar (ES modules, `node:test` for unit tests, chokidar), Swift/SwiftUI app (AppKit bridging), Claude Agent SDK + Codex SDK, drive harness for live integration tests.

## Execution policy

Fable-5 orchestrates and does NOT write source code in the main session. Sidecar/Node tasks (2-8) go to `codex exec` (gpt-5.5) via a thin sonnet wrapper subagent; Swift tasks (1, 9-11) go to an opus-4.8 subagent (user-facing macOS app, taste ≥ 7). Task 12 (docs) may be done inline. Fable reviews every diff between tasks. Task 13 is a manual user gate — the orchestrator must stop and wait.

## Global Constraints

- Node >= 18 (`sidecar/package.json` engines). No new npm dependencies.
- **Never run `xcodebuild` from the terminal** — it invalidates TCC permissions. Swift changes are verified by the user pressing Cmd+R in Xcode (Task 13 gate). Swift tasks must compile by inspection: match existing types exactly.
- Naming: optimize for clarity over concision; no single-character variables; pass props/arguments under their original names (project CLAUDE.md).
- All interactive SwiftUI elements show a pointer cursor on hover (`.pointerCursor()`).
- Do not fix known non-blocking warnings (Swift 6 concurrency, deprecated onChange).
- Sidecar unit tests must sandbox state via `CLICKY_LESSONS_ROOT` (a fresh temp dir per test file); never touch `~/Documents/OpenClicky Lessons/`.
- Commit after every task, imperative mood, explain the why.
- The `general` workspace id string is `"general"` (exported as `GENERAL_WORKSPACE_ID`); the new chat workspace id is `".chat"` (dot prefix hides it from `listWorkspaces()` which filters `entry.name.startsWith(".")`).
- The teach skill, lesson file format, `[POINT:...]` protocol, and TTS are out of scope (spec: Out of scope).

---

### Task 1: Wire keyterms into Apple Speech (contextualStrings)

**Files:**
- Modify: `leanring-buddy/AppleSpeechTranscriptionProvider.swift:26-42` (pass keyterms through) and `:73-97` (consume them)

**Interfaces:**
- Consumes: `keyterms: [String]` already built by `BuddyDictationManager.buildTranscriptionKeyterms()` and passed to `startStreamingSession(keyterms:...)` (currently ignored by this provider).
- Produces: no signature changes — behavior only.

- [ ] **Step 1: Thread keyterms into the session initializer**

In `AppleSpeechTranscriptionProvider.startStreamingSession`, pass the parameter on:

```swift
        return try AppleSpeechTranscriptionSession(
            speechRecognizer: speechRecognizer,
            keyterms: keyterms,
            onTranscriptUpdate: onTranscriptUpdate,
            onFinalTranscriptReady: onFinalTranscriptReady,
            onError: onError
        )
```

- [ ] **Step 2: Accept and apply keyterms in `AppleSpeechTranscriptionSession.init`**

Add the parameter and set `contextualStrings` next to the other request configuration (after `recognitionRequest.addsPunctuation = true`):

```swift
    init(
        speechRecognizer: SFSpeechRecognizer,
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) throws {
```

```swift
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.taskHint = .dictation
        recognitionRequest.addsPunctuation = true
        // Bias recognition toward the app's domain vocabulary (topic names,
        // tech terms like "JavaScript") — without this the on-device model
        // regularly mishears proper nouns. AssemblyAI already consumes these
        // same keyterms; Apple Speech was silently dropping them.
        recognitionRequest.contextualStrings = keyterms
```

- [ ] **Step 3: Add common learning terms to the base keyterm list**

In `leanring-buddy/BuddyDictationManager.swift`, the `baseKeyterms` array (ends at the `"localhost"` entry around line 664) gains entries that matter for the teach flow:

```swift
            "localhost",
            "JavaScript",
            "TypeScript",
            "CSS",
            "flexbox",
            "teach me",
            "lesson",
            "Clicky"
```

- [ ] **Step 4: Verify by inspection and commit**

No terminal build (TCC constraint). Confirm: parameter threaded, no other provider signatures touched.

```bash
git add leanring-buddy/AppleSpeechTranscriptionProvider.swift leanring-buddy/BuddyDictationManager.swift
git commit -m "Wire transcription keyterms into Apple Speech contextualStrings"
```

---

### Task 2: Sidecar unit-test infrastructure + teach-tag parser

**Files:**
- Create: `leanring-buddy/sidecar/src/teachTag.mjs`
- Create: `leanring-buddy/sidecar/test/unit/teachTag.test.mjs`
- Modify: `leanring-buddy/sidecar/package.json` (add test script)

**Interfaces:**
- Produces: `parseTeachTag(responseText) -> { cleanedText: string, dispatch: { topicText: string, instructions: string } | null }`. Later tasks (Task 7) call this on every chat-plane response. `topicText` is the raw text between the first two colons (Task 7 slugifies it via `createWorkspace`); `instructions` defaults to `"start this topic from the basics"` when the tag has no instructions segment.

- [ ] **Step 1: Add the test script**

In `sidecar/package.json` scripts:

```json
    "test": "node --test test/unit/",
```

- [ ] **Step 2: Write the failing tests**

`test/unit/teachTag.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeachTag } from "../../src/teachTag.mjs";

test("extended tag with instructions is parsed and stripped", () => {
  const parsed = parseTeachTag(
    "on it — adding that to your japanese lessons. [TEACH:japanese:build the anime phrases on screen into the next lesson]"
  );
  assert.equal(parsed.cleanedText, "on it — adding that to your japanese lessons.");
  assert.deepEqual(parsed.dispatch, {
    topicText: "japanese",
    instructions: "build the anime phrases on screen into the next lesson",
  });
});

test("legacy tag without instructions gets the default instruction", () => {
  const parsed = parseTeachTag("let's learn flexbox! [TEACH:css flexbox]");
  assert.equal(parsed.cleanedText, "let's learn flexbox!");
  assert.deepEqual(parsed.dispatch, {
    topicText: "css flexbox",
    instructions: "start this topic from the basics",
  });
});

test("instructions may contain colons", () => {
  const parsed = parseTeachTag("sure. [TEACH:git:cover rebase: interactive mode and conflicts]");
  assert.equal(parsed.dispatch.topicText, "git");
  assert.equal(parsed.dispatch.instructions, "cover rebase: interactive mode and conflicts");
});

test("no tag means no dispatch and untouched text", () => {
  const parsed = parseTeachTag("html is the skeleton of every web page.");
  assert.equal(parsed.cleanedText, "html is the skeleton of every web page.");
  assert.equal(parsed.dispatch, null);
});

test("malformed tag (empty topic) is stripped but not dispatched", () => {
  const parsed = parseTeachTag("hmm. [TEACH:]");
  assert.equal(parsed.cleanedText, "hmm.");
  assert.equal(parsed.dispatch, null);
});

test("only the first valid tag dispatches; all tags are stripped from speech", () => {
  const parsed = parseTeachTag("okay! [TEACH:japanese:lesson one] [TEACH:french:lesson one]");
  assert.equal(parsed.dispatch.topicText, "japanese");
  assert.equal(parsed.cleanedText.includes("[TEACH"), false);
});

test("point tag is left alone for the app to parse", () => {
  const parsed = parseTeachTag("click the gear icon. [POINT:100,42:settings]");
  assert.equal(parsed.cleanedText, "click the gear icon. [POINT:100,42:settings]");
  assert.equal(parsed.dispatch, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: FAIL — `Cannot find module '../../src/teachTag.mjs'`

- [ ] **Step 4: Implement the parser**

`src/teachTag.mjs`:

```js
// Parser for the extended teach tag the chat agent emits:
//   [TEACH:topic]                      (legacy shape, default instructions)
//   [TEACH:topic:instructions...]     (instructions may contain colons)
//
// The sidecar strips every teach tag from the spoken reply and dispatches at
// most the FIRST well-formed one. A tag with an empty topic is malformed:
// stripped from speech (never read a tag aloud) but not dispatched, per the
// design's error-handling rules.

const TEACH_TAG_PATTERN = /\[TEACH:([^:\][]*)(?::([^\][]*))?\]/gi;

export const DEFAULT_TEACH_INSTRUCTIONS = "start this topic from the basics";

export function parseTeachTag(responseText) {
  let dispatch = null;

  const cleanedText = String(responseText ?? "")
    .replace(TEACH_TAG_PATTERN, (fullMatch, rawTopicText, rawInstructions) => {
      const topicText = (rawTopicText ?? "").trim();
      if (topicText !== "" && dispatch === null) {
        const instructions = (rawInstructions ?? "").trim();
        dispatch = {
          topicText,
          instructions: instructions === "" ? DEFAULT_TEACH_INSTRUCTIONS : instructions,
        };
      }
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { cleanedText, dispatch };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add leanring-buddy/sidecar/src/teachTag.mjs leanring-buddy/sidecar/test/unit/teachTag.test.mjs leanring-buddy/sidecar/package.json
git commit -m "Add sidecar unit tests and extended TEACH tag parser"
```

---

### Task 3: Topic roster builder

**Files:**
- Create: `leanring-buddy/sidecar/src/topicRoster.mjs`
- Create: `leanring-buddy/sidecar/test/unit/topicRoster.test.mjs`

**Interfaces:**
- Consumes: `listWorkspaces()`, `GENERAL_WORKSPACE_ID` from `./workspaces.mjs` (already exported).
- Produces: `buildTopicRosterText() -> string` and `composeChatTurnText(transcript, rosterText) -> string`. Task 7 appends the roster to every chat-plane turn.

- [ ] **Step 1: Write the failing tests**

`test/unit/topicRoster.test.mjs`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox BEFORE importing modules that read the env at call time.
const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-roster-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const { createWorkspace } = await import("../../src/workspaces.mjs");
const { buildTopicRosterText, composeChatTurnText } = await import("../../src/topicRoster.mjs");

test("empty root produces the no-topics roster", () => {
  const rosterText = buildTopicRosterText();
  assert.ok(rosterText.includes("[topic roster]"));
  assert.ok(rosterText.includes("no lesson topics exist yet"));
  assert.ok(rosterText.includes("[end roster]"));
});

test("topics appear with slug and lesson count; general and dot-dirs are excluded", () => {
  createWorkspace("general");
  createWorkspace("CSS Flexbox");
  const lessonsDirectory = join(sandboxRoot, "css-flexbox", "lessons");
  mkdirSync(lessonsDirectory, { recursive: true });
  writeFileSync(join(lessonsDirectory, "0001-intro.html"), "<html></html>");
  mkdirSync(join(sandboxRoot, ".chat"), { recursive: true });

  const rosterText = buildTopicRosterText();
  assert.ok(rosterText.includes("CSS Flexbox"));
  assert.ok(rosterText.includes("(slug: css-flexbox)"));
  assert.ok(rosterText.includes("1 lesson"));
  assert.equal(rosterText.includes("general"), false);
  assert.equal(rosterText.includes(".chat"), false);
});

test("composeChatTurnText appends the roster after the transcript", () => {
  const composedText = composeChatTurnText("what topics do i have?", "[topic roster]\n[end roster]");
  assert.ok(composedText.startsWith("what topics do i have?"));
  assert.ok(composedText.endsWith("[end roster]"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: teachTag tests PASS, topicRoster tests FAIL with module-not-found.

- [ ] **Step 3: Implement**

`src/topicRoster.mjs`:

```js
// Per-turn topic roster injection (chat plane).
//
// Every ephemeral chat turn carries a compact, freshly-read roster of the
// lesson topics on disk. This is the chat agent's only memory of what topics
// exist, so it can never dispatch to an imagined folder. The rules in
// companionRules.mjs tell the agent the roster is system context (never read
// aloud) and that unknown topics require a spoken confirmation first.

import { GENERAL_WORKSPACE_ID, listWorkspaces } from "./workspaces.mjs";

export function buildTopicRosterText() {
  const topics = listWorkspaces().filter(
    (workspace) => workspace.id !== GENERAL_WORKSPACE_ID
  );

  if (topics.length === 0) {
    return "[topic roster]\n(no lesson topics exist yet)\n[end roster]";
  }

  const rosterLines = topics.map((workspace) => {
    const lessonLabel = workspace.lessonCount === 1 ? "1 lesson" : `${workspace.lessonCount} lessons`;
    const lastUsedLabel = workspace.lastUsedAt ? `last used ${workspace.lastUsedAt.slice(0, 10)}` : "never used";
    return `- ${workspace.name} (slug: ${workspace.id}) — ${lessonLabel}, ${lastUsedLabel}`;
  });

  return `[topic roster]\n${rosterLines.join("\n")}\n[end roster]`;
}

export function composeChatTurnText(transcript, rosterText) {
  return `${transcript}\n\n${rosterText}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add leanring-buddy/sidecar/src/topicRoster.mjs leanring-buddy/sidecar/test/unit/topicRoster.test.mjs
git commit -m "Add per-turn topic roster builder for the chat plane"
```

---

### Task 4: Static lessons dashboard generator

**Files:**
- Create: `leanring-buddy/sidecar/src/lessonsDashboard.mjs`
- Create: `leanring-buddy/sidecar/test/unit/lessonsDashboard.test.mjs`

**Interfaces:**
- Consumes: `lessonsRootDirectory()`, `GENERAL_WORKSPACE_ID`, `listWorkspaces()` from `./workspaces.mjs`.
- Produces: `regenerateLessonsDashboard() -> string` (writes and returns the absolute path of `<lessonsRoot>/index.html`) and `lessonsDashboardPath() -> string`. Task 7 calls regenerate at startup, after workspace creation, and on every `lessonCreated`; Task 9's `ready` event carries the path to the app.

- [ ] **Step 1: Write the failing tests**

`test/unit/lessonsDashboard.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-dashboard-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const { createWorkspace } = await import("../../src/workspaces.mjs");
const { regenerateLessonsDashboard, lessonsDashboardPath } = await import(
  "../../src/lessonsDashboard.mjs"
);

test("dashboard is created with an empty state when no topics exist", () => {
  const dashboardPath = regenerateLessonsDashboard();
  assert.equal(dashboardPath, join(sandboxRoot, "index.html"));
  assert.ok(existsSync(dashboardPath));
  const dashboardHtml = readFileSync(dashboardPath, "utf8");
  assert.ok(dashboardHtml.includes("No lessons yet"));
});

test("topics list every lesson as a relative link with the latest marked", () => {
  createWorkspace("Japanese");
  const lessonsDirectory = join(sandboxRoot, "japanese", "lessons");
  mkdirSync(lessonsDirectory, { recursive: true });
  writeFileSync(join(lessonsDirectory, "0001-hiragana.html"), "<html></html>");
  writeFileSync(join(lessonsDirectory, "0002-katakana.html"), "<html></html>");

  const dashboardHtml = readFileSync(regenerateLessonsDashboard(), "utf8");
  assert.ok(dashboardHtml.includes("Japanese"));
  assert.ok(dashboardHtml.includes('href="japanese/lessons/0001-hiragana.html"'));
  assert.ok(dashboardHtml.includes('href="japanese/lessons/0002-katakana.html"'));
  // Latest lesson (highest number) carries the highlight class.
  const latestIndex = dashboardHtml.indexOf("0002-katakana.html");
  const highlightIndex = dashboardHtml.lastIndexOf('class="latest"', latestIndex);
  assert.ok(highlightIndex !== -1 && highlightIndex < latestIndex);
});

test("topic names are HTML-escaped", () => {
  createWorkspace("Tricks & <Tips>");
  const dashboardHtml = readFileSync(regenerateLessonsDashboard(), "utf8");
  assert.ok(dashboardHtml.includes("Tricks &amp; &lt;Tips&gt;"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: new file FAILs with module-not-found; earlier suites PASS.

- [ ] **Step 3: Implement**

`src/lessonsDashboard.mjs`:

```js
// Static lessons dashboard.
//
// A plain index.html at the lessons root that links every topic's lessons.
// No server, no JavaScript, no model calls — regenerated whenever a lesson
// or workspace changes, and opened by the app's "Lessons" button. Lessons
// are found by navigation, not conversation (design decision).

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERAL_WORKSPACE_ID,
  lessonsRootDirectory,
  listWorkspaces,
  workspacePath,
} from "./workspaces.mjs";

export function lessonsDashboardPath() {
  return join(lessonsRootDirectory(), "index.html");
}

function escapeHtml(rawText) {
  return String(rawText)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lessonFileNamesForTopic(workspaceId) {
  const lessonsDirectory = join(workspacePath(workspaceId), "lessons");
  if (!existsSync(lessonsDirectory)) return [];
  return readdirSync(lessonsDirectory)
    .filter((fileName) => fileName.endsWith(".html"))
    .sort();
}

function topicSectionHtml(workspace) {
  const lessonFileNames = lessonFileNamesForTopic(workspace.id);
  if (lessonFileNames.length === 0) {
    return `<section><h2>${escapeHtml(workspace.name)}</h2><p class="empty">No lessons yet — say "teach me ${escapeHtml(workspace.name)}" to start.</p></section>`;
  }
  const latestLessonFileName = lessonFileNames[lessonFileNames.length - 1];
  const lessonListItems = lessonFileNames
    .map((lessonFileName) => {
      const relativeHref = `${workspace.id}/lessons/${lessonFileName}`;
      const isLatest = lessonFileName === latestLessonFileName;
      return `<li${isLatest ? ' class="latest"' : ""}><a href="${escapeHtml(relativeHref)}">${escapeHtml(lessonFileName.replace(/\.html$/, ""))}</a>${isLatest ? " <em>latest</em>" : ""}</li>`;
    })
    .join("\n");
  return `<section><h2>${escapeHtml(workspace.name)}</h2><ol>\n${lessonListItems}\n</ol></section>`;
}

export function regenerateLessonsDashboard() {
  const topics = listWorkspaces().filter(
    (workspace) => workspace.id !== GENERAL_WORKSPACE_ID
  );

  const bodyHtml =
    topics.length === 0
      ? `<p class="empty">No lessons yet. Say "teach me &lt;topic&gt;" to Clicky to start your first one.</p>`
      : topics.map(topicSectionHtml).join("\n");

  const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenClicky Lessons</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; background: #111; color: #eee; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: #7ab8ff; text-decoration: none; } a:hover { text-decoration: underline; }
  li.latest a { font-weight: 600; } em { color: #888; font-style: normal; font-size: 0.85em; margin-left: 0.4em; }
  .empty { color: #999; }
</style>
</head>
<body>
<h1>OpenClicky Lessons</h1>
${bodyHtml}
</body>
</html>
`;

  const dashboardPath = lessonsDashboardPath();
  writeFileSync(dashboardPath, dashboardHtml);
  return dashboardPath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add leanring-buddy/sidecar/src/lessonsDashboard.mjs leanring-buddy/sidecar/test/unit/lessonsDashboard.test.mjs
git commit -m "Generate static lessons dashboard at the lessons root"
```

---

### Task 5: Chat workspace support in workspaces.mjs

**Files:**
- Modify: `leanring-buddy/sidecar/src/workspaces.mjs`
- Create: `leanring-buddy/sidecar/test/unit/chatWorkspace.test.mjs`

**Interfaces:**
- Consumes: `COMPANION_CHAT_NOTES` from `./companionRules.mjs` (added in Task 6 — for THIS task import `COMPANION_WORKSPACE_NOTES` and switch the import in Task 6; see Step 3 note).
- Produces: `CHAT_WORKSPACE_ID = ".chat"`, `ensureChatWorkspaceExists()`, `clearChatSessionIds()`. Task 7 calls both at startup; both backends' existing session machinery works on `.chat` unmodified because `workspacePath(".chat")` and `.clicky.json` metadata already resolve for any folder name.

- [ ] **Step 1: Write the failing tests**

`test/unit/chatWorkspace.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxRoot = mkdtempSync(join(tmpdir(), "clicky-chat-ws-test-"));
process.env.CLICKY_LESSONS_ROOT = sandboxRoot;

const {
  CHAT_WORKSPACE_ID,
  ensureChatWorkspaceExists,
  clearChatSessionIds,
  listWorkspaces,
  readWorkspaceMetadata,
  updateWorkspaceMetadata,
} = await import("../../src/workspaces.mjs");

test("chat workspace is created hidden with agent notes", () => {
  ensureChatWorkspaceExists();
  assert.equal(CHAT_WORKSPACE_ID, ".chat");
  assert.ok(existsSync(join(sandboxRoot, ".chat", "AGENTS.md")));
  // Dot prefix keeps it out of the topic list and roster.
  assert.equal(listWorkspaces().some((workspace) => workspace.id === ".chat"), false);
});

test("clearChatSessionIds wipes both backends' resume ids", () => {
  updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
    claudeSessionId: "stale-claude",
    codexThreadId: "stale-codex",
  });
  clearChatSessionIds();
  const chatMetadata = readWorkspaceMetadata(CHAT_WORKSPACE_ID);
  assert.equal(chatMetadata.claudeSessionId, null);
  assert.equal(chatMetadata.codexThreadId, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: FAIL — `CHAT_WORKSPACE_ID` not exported.

- [ ] **Step 3: Implement in `workspaces.mjs`**

Add below the `GENERAL_WORKSPACE_ID` export:

```js
export const CHAT_WORKSPACE_ID = ".chat";
```

Add at the end of the file (after `workspaceExists`):

```js
/**
 * The ephemeral chat plane lives in a hidden dot-folder under the lessons
 * root: existing session/metadata machinery works on it unchanged, while the
 * dot prefix keeps it out of listWorkspaces(), the roster, and the dashboard.
 * Created directly (not via createWorkspace) because slugifyTopicName would
 * strip the dot.
 */
export function ensureChatWorkspaceExists() {
  const chatDirectoryPath = workspacePath(CHAT_WORKSPACE_ID);
  const chatWorkspaceAlreadyExisted = existsSync(chatDirectoryPath);
  mkdirSync(chatDirectoryPath, { recursive: true });

  const agentsFilePath = join(chatDirectoryPath, "AGENTS.md");
  const expectedAgentsFileContent = COMPANION_CHAT_NOTES + "\n";
  const currentAgentsFileContent = existsSync(agentsFilePath)
    ? readFileSync(agentsFilePath, "utf8")
    : null;
  if (currentAgentsFileContent !== expectedAgentsFileContent) {
    writeFileSync(agentsFilePath, expectedAgentsFileContent);
  }

  if (!chatWorkspaceAlreadyExisted) {
    updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
      name: "ephemeral chat",
      slug: CHAT_WORKSPACE_ID,
      createdAt: new Date().toISOString(),
    });
  }
}

/** Chat context never survives an app restart (design decision). */
export function clearChatSessionIds() {
  if (!workspaceExists(CHAT_WORKSPACE_ID)) return;
  updateWorkspaceMetadata(CHAT_WORKSPACE_ID, {
    claudeSessionId: null,
    codexThreadId: null,
  });
}
```

Update the import at the top of `workspaces.mjs`:

```js
import { COMPANION_CHAT_NOTES, COMPANION_WORKSPACE_NOTES } from "./companionRules.mjs";
```

**Note:** `COMPANION_CHAT_NOTES` does not exist until Task 6. To keep this task green on its own, add a minimal placeholder export at the very end of `companionRules.mjs` now; Task 6 replaces it with the real content:

```js
export const COMPANION_CHAT_NOTES = COMPANION_WORKSPACE_NOTES;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS (15 tests total)

- [ ] **Step 5: Commit**

```bash
git add leanring-buddy/sidecar/src/workspaces.mjs leanring-buddy/sidecar/src/companionRules.mjs leanring-buddy/sidecar/test/unit/chatWorkspace.test.mjs
git commit -m "Add hidden ephemeral chat workspace with restart session reset"
```

---

### Task 6: Rewrite companion rules for the chat-plane protocol

**Files:**
- Modify: `leanring-buddy/sidecar/src/companionRules.mjs`

**Interfaces:**
- Produces: updated `COMPANION_RULES` (Claude chat system-prompt append), real `COMPANION_CHAT_NOTES` (Codex `.chat/AGENTS.md`), trimmed `COMPANION_WORKSPACE_NOTES` (topic workspaces; loses the TEACH-emission bullet because topic sessions no longer originate tags).

- [ ] **Step 1: Replace the `learning topics` section of `COMPANION_RULES`**

Replace the two paragraphs starting at `learning topics:` (currently lines 48-53) with:

```
learning topics:
the user can build permanent lesson courses with you over time. each topic lives in its own workspace and its lessons are numbered html pages. you never write lessons yourself in chat — you dispatch the work with a tag, and a dedicated teach session builds the lesson.

every turn, a [topic roster] block is appended after the user's words. it is system context, not something the user said: never read it aloud or mention it. it lists every lesson topic that exists, with its slug.

when the user asks to learn or be taught a topic over time, or to add something to their lessons — like "teach me css flexbox", "add these phrases to my japanese lessons", or "continue my typescript course" — acknowledge in one short spoken sentence and append exactly one tag at the very end of your response, after any point tag:

[TEACH:topic-slug:instructions for this lesson]

- topic-slug must be a slug from the roster when the topic already exists.
- instructions describe what the next lesson should cover. when the user is reacting to something on screen, describe the relevant screen content in the instructions yourself — the teach session cannot see the screen.
- if the topic is NOT in the roster, do not emit a tag yet. ask by voice first, like "i don't have a japanese topic yet — want me to start one?". only after the user confirms on a later turn do you emit the tag with a new short slug.
- a one-off question like "what is flexbox?" is NOT a teach request — answer it normally with no tag.

examples:
- "teach me japanese" (japanese in roster) → "on it — queuing up your next japanese lesson. [TEACH:japanese:continue the course from where the learning records leave off]"
- "add this to my next lesson" while anime subtitles are on screen (japanese in roster) → "nice, adding those to your japanese lessons. [TEACH:japanese:the user was watching anime with these phrases on screen: <the phrases you saw>. build them into the next lesson]"
- "teach me rust" (rust NOT in roster) → "i don't have a rust topic yet — want me to start one for you? [POINT:none]" (no TEACH tag until they confirm)

lesson dispatch is asynchronous: after you emit the tag, the lesson builds in the background and opens in the user's browser by itself. never promise to "show it now" — say it's on the way.
```

- [ ] **Step 2: Replace the placeholder `COMPANION_CHAT_NOTES`**

Replace `export const COMPANION_CHAT_NOTES = COMPANION_WORKSPACE_NOTES;` (added in Task 5) with a full Codex-facing version. It must carry the same voice rules, POINT protocol, and the learning-topics protocol above, because Codex chat sessions read AGENTS.md instead of a system prompt:

```js
export const COMPANION_CHAT_NOTES = `# openclicky chat notes

${COMPANION_RULES}`;
```

- [ ] **Step 3: Trim `COMPANION_WORKSPACE_NOTES`**

Delete this bullet from `COMPANION_WORKSPACE_NOTES` (topic sessions are teach-only now and must never emit tags):

```
- if the user asks to learn or be taught a topic over time (not a one-off
  question), acknowledge in one short sentence and append [TEACH:topic name]
  at the very end. never emit [TEACH:...] inside an existing topic workspace.
```

- [ ] **Step 4: Run the unit suite (regression only)**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS — chatWorkspace test still green with the real `COMPANION_CHAT_NOTES`.

- [ ] **Step 5: Commit**

```bash
git add leanring-buddy/sidecar/src/companionRules.mjs
git commit -m "Rewrite companion rules for roster-grounded TEACH dispatch"
```

---

### Task 7: Wire the split into index.mjs (routing, dispatch, idle reset, dashboard)

**Files:**
- Modify: `leanring-buddy/sidecar/index.mjs`
- Modify: `leanring-buddy/sidecar/src/lessonWatcher.mjs` (dashboard hook)

**Interfaces:**
- Consumes: `parseTeachTag` (Task 2), `buildTopicRosterText`/`composeChatTurnText` (Task 3), `regenerateLessonsDashboard`/`lessonsDashboardPath` (Task 4), `CHAT_WORKSPACE_ID`/`ensureChatWorkspaceExists`/`clearChatSessionIds` (Task 5).
- Produces (protocol changes Task 9 depends on):
  - `chat` requests with `workspaceId` missing or `"general"` run on the chat plane; any other explicit `workspaceId` keeps today's direct-to-workspace behavior (drive `teach`/`resume` modes keep working).
  - `ready` event gains `lessonsRoot` and `dashboardPath` string fields.
  - New `teachError` event: `{ type: "teachError", workspaceId, topicName, message }`.
  - Env knob `CLICKY_CHAT_IDLE_MS` (default `600000`) for the idle reset window.

- [ ] **Step 1: Update imports in `index.mjs`**

```js
const {
  createWorkspace,
  describeWorkspace,
  ensureChatWorkspaceExists,
  clearChatSessionIds,
  listWorkspaces,
  workspaceExists,
  CHAT_WORKSPACE_ID,
  GENERAL_WORKSPACE_ID,
} = await import("./src/workspaces.mjs");
const { parseTeachTag } = await import("./src/teachTag.mjs");
const { buildTopicRosterText, composeChatTurnText } = await import("./src/topicRoster.mjs");
const { regenerateLessonsDashboard, lessonsDashboardPath } = await import(
  "./src/lessonsDashboard.mjs"
);
```

(`ensureGeneralWorkspaceExists` import is removed.)

- [ ] **Step 2: Replace `handleChatRequest` with chat-plane routing**

```js
const CHAT_IDLE_RESET_MS = Number(process.env.CLICKY_CHAT_IDLE_MS ?? 600_000);
let chatIdleResetTimer = null;

function armChatIdleReset() {
  clearTimeout(chatIdleResetTimer);
  chatIdleResetTimer = setTimeout(async () => {
    emitLog("info", "chat idle window elapsed — resetting ephemeral chat sessions");
    await resetClaudeSession(CHAT_WORKSPACE_ID);
    await resetCodexSession(CHAT_WORKSPACE_ID);
  }, CHAT_IDLE_RESET_MS);
  // Never keep the process alive just for the reset timer.
  chatIdleResetTimer.unref?.();
}

/**
 * Builds a lesson in the topic's persistent teach session, in the background.
 * The chat result has already been emitted — failures surface as a dedicated
 * teachError event the app speaks, and success surfaces as the existing
 * lessonCreated event from the watcher.
 */
async function dispatchTeachInstructions({ backend, model, effort, topicText, instructions }) {
  let workspace;
  try {
    workspace = createWorkspace(topicText);
    const teachInstall = await ensureTeachSkillInstalled(workspace.path);
    if (!teachInstall.installed) {
      emitEvent({ type: "teachError", workspaceId: workspace.id, topicName: topicText, message: teachInstall.message });
      return;
    }
    regenerateLessonsDashboard();
    watchWorkspaceLessons(workspace.id, backend);

    const dispatchArguments = {
      requestId: `teach-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: workspace.id,
      model,
      effort,
      text: instructions,
      images: [],
      teachIntent: true,
      onStatus: null,
    };
    if (backend === "codex") {
      await runCodexChatTurn(dispatchArguments);
    } else {
      await runClaudeChatTurn(dispatchArguments);
    }
  } catch (dispatchError) {
    emitEvent({
      type: "teachError",
      workspaceId: workspace?.id ?? null,
      topicName: topicText,
      message: String(dispatchError?.message ?? dispatchError),
    });
  }
}

async function handleChatRequest(request) {
  // The chat plane owns every voice turn. An explicit non-general workspaceId
  // is the legacy direct path, kept for the terminal drive harness.
  const isChatPlaneTurn =
    !request.workspaceId || request.workspaceId === GENERAL_WORKSPACE_ID;
  const workspaceId = isChatPlaneTurn ? CHAT_WORKSPACE_ID : request.workspaceId;

  if (!isChatPlaneTurn && !workspaceExists(workspaceId)) {
    emitError(request.id, "workspace_missing", `workspace "${workspaceId}" does not exist`);
    return;
  }

  watchWorkspaceLessons(workspaceId, request.backend);

  const onStatus = (statusUpdate) => {
    emitEvent({ id: request.id, type: "status", ...statusUpdate });
  };

  const turnText = isChatPlaneTurn
    ? composeChatTurnText(request.text ?? "", buildTopicRosterText())
    : request.text ?? "";

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

  const turnResult =
    request.backend === "codex"
      ? await runCodexChatTurn(chatTurnArguments)
      : await runClaudeChatTurn(chatTurnArguments);

  let responseText = turnResult.text;
  if (isChatPlaneTurn) {
    armChatIdleReset();
    const { cleanedText, dispatch } = parseTeachTag(responseText);
    responseText = cleanedText;
    if (dispatch) {
      // Fire-and-forget: a minutes-long lesson build never blocks the chat.
      void dispatchTeachInstructions({
        backend: request.backend,
        model: request.model,
        effort: request.effort,
        topicText: dispatch.topicText,
        instructions: dispatch.instructions,
      });
    }
  }

  emitEvent({
    id: request.id,
    type: "result",
    text: responseText,
    sessionId: turnResult.sessionId ?? null,
    durationMs: turnResult.durationMs ?? null,
  });
}
```

- [ ] **Step 3: Update startup**

Replace `ensureGeneralWorkspaceExists();` (line 179) with:

```js
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
```

And extend the `ready` event (bottom of file):

```js
emitEvent({
  type: "ready",
  version: SIDECAR_VERSION,
  node: process.version,
  sidecarPath: process.cwd(),
  lessonsRoot: lessonsRootDirectory(),
  dashboardPath: lessonsDashboardPath(),
});
```

Add `lessonsRootDirectory` to the workspaces import in Step 1.

- [ ] **Step 4: Hook the dashboard into the lesson watcher**

In `src/lessonWatcher.mjs`, import the generator and regenerate inside the `add` handler's `setTimeout`, before `emitEvent`:

```js
import { regenerateLessonsDashboard } from "./lessonsDashboard.mjs";
```

```js
    setTimeout(() => {
      regenerateLessonsDashboard();
      emitEvent({
        type: "lessonCreated",
        workspaceId,
        path: addedFilePath,
        openedByAgent: didAgentOpenLesson(workspaceId, lessonFileName),
      });
    }, 2000);
```

- [ ] **Step 5: Run the unit suite and a protocol smoke test**

Run: `cd leanring-buddy/sidecar && npm test`
Expected: PASS.

Run (no model call, just startup + protocol):
```bash
cd leanring-buddy/sidecar && CLICKY_LESSONS_ROOT=$(mktemp -d) node -e '
import("node:child_process").then(({ spawn }) => {
  const sidecar = spawn("node", ["index.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  sidecar.stdout.on("data", (data) => { process.stdout.write(data); sidecar.kill(); });
});'
```
Expected: a `ready` event line containing `"lessonsRoot"` and `"dashboardPath"`.

- [ ] **Step 6: Commit**

```bash
git add leanring-buddy/sidecar/index.mjs leanring-buddy/sidecar/src/lessonWatcher.mjs
git commit -m "Route voice through ephemeral chat plane with async TEACH dispatch"
```

---

### Task 8: Drive-harness integration mode for the split

**Files:**
- Modify: `leanring-buddy/sidecar/test/drive.mjs`
- Modify: `leanring-buddy/sidecar/package.json` (add `drive:split` script)

**Interfaces:**
- Consumes: the sidecar protocol from Task 7 (`chat` with no `workspaceId`, `teachError`, `lessonCreated`) and drive helpers `startSidecar()`, `newRequestId()`, `assertCondition()`, `SidecarProcess.waitFor/waitForCompletion` (already in drive.mjs).
- Produces: `npm run drive:split -- --backend claude|codex` live test. Runs against real subscriptions.

- [ ] **Step 1: Add the drive function**

Add to `test/drive.mjs` next to the other `run*Drive` functions:

```js
async function runSplitDrive() {
  const sidecar = await startSidecar();

  // 1. Chat-plane turn instructed to emit the extended tag verbatim, so the
  //    routing is tested without depending on the model's own intent detection.
  const chatRequestId = newRequestId();
  sidecar.send({
    id: chatRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text:
      'this is a routing test. reply with one short sentence and end your reply with exactly this tag, verbatim: [TEACH:drive-split-topic:create a one-page hello lesson that says hello world]',
    images: [],
  });
  const chatCompletion = await sidecar.waitForCompletion(chatRequestId, 300_000);
  assertCondition(chatCompletion.type === "result", `chat turn failed: ${chatCompletion.message}`);
  assertCondition(
    !chatCompletion.text.includes("[TEACH"),
    `tag leaked into spoken text: ${chatCompletion.text}`
  );

  // 2. The dispatch must create the topic workspace and land a lesson.
  const lessonEvent = await sidecar.waitFor(
    (event) => event.type === "lessonCreated" && event.workspaceId === "drive-split-topic",
    600_000
  );
  console.log(`[drive] lesson created: ${lessonEvent.path}`);

  // 3. Dashboard exists and links the new lesson.
  const { readFileSync } = await import("node:fs");
  const dashboardHtml = readFileSync(
    join(driveEnvironment.CLICKY_LESSONS_ROOT ?? "", "index.html"),
    "utf8"
  );
  assertCondition(
    dashboardHtml.includes("drive-split-topic"),
    "dashboard does not list the dispatched topic"
  );

  // 4. Idle reset: with CLICKY_CHAT_IDLE_MS=3000 in the drive env, teach the
  //    chat a codeword, wait past the window, and confirm it is forgotten.
  const codeword = `split-${Date.now()}`;
  const memorizeRequestId = newRequestId();
  sidecar.send({
    id: memorizeRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text: `remember this codeword and repeat it back: ${codeword}`,
    images: [],
  });
  const memorizeCompletion = await sidecar.waitForCompletion(memorizeRequestId, 300_000);
  assertCondition(memorizeCompletion.type === "result", "memorize turn failed");

  await new Promise((resolvePause) => setTimeout(resolvePause, 6_000));

  const recallRequestId = newRequestId();
  sidecar.send({
    id: recallRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text: "what codeword did i give you earlier? if you do not know, say exactly: no codeword",
    images: [],
  });
  const recallCompletion = await sidecar.waitForCompletion(recallRequestId, 300_000);
  assertCondition(recallCompletion.type === "result", "recall turn failed");
  assertCondition(
    !recallCompletion.text.includes(codeword),
    `chat session survived the idle window — codeword recalled: ${recallCompletion.text}`
  );

  console.log("\n[PASS] chat plane routes, dispatches, and forgets on idle");
  await sidecar.stop();
}
```

- [ ] **Step 2: Register the mode and the idle env knob**

Add to `driveSubcommands`:

```js
  split: runSplitDrive,
```

In the `driveEnvironment` setup block (after `driveEnvironment.CLICKY_APP_SUPPORT = appSupport;`):

```js
driveEnvironment.CLICKY_CHAT_IDLE_MS = process.env.CLICKY_CHAT_IDLE_MS ?? "3000";
```

Add the npm script:

```json
    "drive:split": "node test/drive.mjs split",
```

- [ ] **Step 3: Run the live integration test (both backends)**

Run: `cd leanring-buddy/sidecar && npm run drive:split -- --backend claude`
Expected: `[PASS] chat plane routes, dispatches, and forgets on idle`

Run: `npm run drive:split -- --backend codex`
Expected: same PASS.

These hit live subscriptions and can take several minutes each. If a step fails, fix Task 7 wiring before proceeding — this gate protects the Swift tasks from building on a broken sidecar.

- [ ] **Step 4: Commit**

```bash
git add leanring-buddy/sidecar/test/drive.mjs leanring-buddy/sidecar/package.json
git commit -m "Add drive:split live test for chat routing, dispatch, and idle reset"
```

---

### Task 9: Swift protocol layer — SidecarProcessManager + CompanionBrainProvider

**Files:**
- Modify: `leanring-buddy/SidecarProcessManager.swift` (SidecarEvent fields, `sendChat` signature, ready handling, teachError event)
- Modify: `leanring-buddy/CompanionBrainProvider.swift` (protocol + SidecarBrainProvider `respond` drop `workspaceId`/`teachIntent`)

**Interfaces:**
- Consumes: Task 7's protocol (`ready.dashboardPath`, `teachError`, chat without `workspaceId`).
- Produces (Task 10 depends on): `SidecarProcessManager.lessonsDashboardPath: String?` (published), `onTeachError: (((topicName: String, message: String)) -> Void)?`, `sendChat(requestId:backend:model:effort:text:images:onStatus:)`, and `CompanionBrainProvider.respond(transcript:images:backend:model:effort:onStatus:)`.

- [ ] **Step 1: Extend `SidecarEvent`**

In the `SidecarEvent` struct (SidecarProcessManager.swift:48), add next to `sidecarPath`:

```swift
    var lessonsRoot: String? { rawPayload["lessonsRoot"] as? String }
    var dashboardPath: String? { rawPayload["dashboardPath"] as? String }
    var topicName: String? { rawPayload["topicName"] as? String }
```

- [ ] **Step 2: Publish the dashboard path and surface teachError**

Next to the existing `onLessonCreated` declaration (line 132):

```swift
    /// Absolute path of the static lessons dashboard, reported by the sidecar's
    /// ready event. Nil until the sidecar has started at least once.
    @Published private(set) var lessonsDashboardPath: String?

    /// Fired when a background lesson dispatch fails after the chat turn already
    /// completed — the app speaks this, since no request is pending to throw to.
    var onTeachError: (((topicName: String, message: String)) -> Void)?
```

In `handleSidecarEvent`'s `"ready"` case (line 660), after `status = .ready`:

```swift
            lessonsDashboardPath = event.dashboardPath
```

Add a new case beside `"lessonCreated"`:

```swift
        case "teachError":
            onTeachError?((
                topicName: event.topicName ?? "your topic",
                message: event.message ?? "lesson generation failed"
            ))
```

- [ ] **Step 3: Simplify `sendChat`**

Replace the signature and payload (line 208): remove the `workspaceId: String` and `teachIntent: Bool` parameters, and remove the `"workspaceId"` and `"teachIntent"` payload entries. Everything else is unchanged. Resulting payload:

```swift
            payload: [
                "id": requestId,
                "type": "chat",
                "backend": backend,
                "model": model,
                "effort": effort,
                "text": text,
                "images": images.map { ["path": $0.path, "label": $0.label] }
            ],
```

- [ ] **Step 4: Update `CompanionBrainProvider`**

In the `CompanionBrainProvider` protocol (line 16) and `SidecarBrainProvider.respond` (line 57): delete the `workspaceId: String` and `teachIntent: Bool` parameters, and delete the corresponding `workspaceId:`/`teachIntent:` arguments in the internal `sendChat` call (lines 80/85). No other logic changes — the watchdogs, screenshot file store, and status mapping stay as they are.

- [ ] **Step 5: Verify by inspection and commit**

Grep for stale call sites (they are fixed in Task 10, so ONLY confirm the list matches expectations):

```bash
grep -n "teachIntent\|workspaceId" leanring-buddy/CompanionManager.swift | head -20
```
Expected: hits only inside `CompanionManager.swift` (Task 10's scope), none left in SidecarProcessManager/CompanionBrainProvider.

```bash
git add leanring-buddy/SidecarProcessManager.swift leanring-buddy/CompanionBrainProvider.swift
git commit -m "Drop workspace routing from the chat protocol; surface dashboard path and teachError"
```

**Note:** the project does not build between Tasks 9 and 11 (CompanionManager still references the old signatures until Task 10, the panel until Task 11). That is expected; Tasks 9-11 land as one reviewed sequence before the Task 13 build gate.

---

### Task 10: CompanionManager — remove topic plumbing, add dashboard + teachError

**Files:**
- Modify: `leanring-buddy/CompanionManager.swift`

**Interfaces:**
- Consumes: Task 9's `respond(transcript:images:backend:model:effort:onStatus:)`, `lessonsDashboardPath`, `onTeachError`.
- Produces (Task 11 depends on): `openLessonsDashboard()`. Removes: `selectedWorkspaceId`, `setSelectedWorkspaceId`, `workspaces`, `refreshWorkspaces`, `resetCurrentConversation`, `requestNextLesson`, `beginTeachingTopic`, `parseTeachIntent` (and its result type), the `teachIntent` parameter of `sendTranscriptToClaudeWithScreenshot`.

- [ ] **Step 1: Delete topic/workspace state and actions**

Remove these members entirely:
- `@Published var selectedWorkspaceId` + `setSelectedWorkspaceId` (lines 128-136)
- `@Published private(set) var workspaces: [SidecarWorkspace]` (line 138) and `refreshWorkspaces()` (lines 159-171)
- `resetCurrentConversation()` (lines 183-198)
- `requestNextLesson()` (lines 218-225)
- `beginTeachingTopic(_:)` (lines 736-764)
- the static `parseTeachIntent` function and its result type (search: `grep -n "parseTeachIntent" leanring-buddy/CompanionManager.swift`)

Then find and remove every remaining call site:

```bash
grep -n "refreshWorkspaces\|selectedWorkspaceId\|parseTeachIntent\|beginTeachingTopic" leanring-buddy/*.swift
```

(`start()` calls `refreshWorkspaces()`; CompanionPanelView references are removed in Task 11.)

- [ ] **Step 2: Simplify the send path**

`sendTranscriptToClaudeWithScreenshot(transcript:teachIntent:)` becomes `sendTranscriptToClaudeWithScreenshot(transcript:)`. Inside it:

The `brain.respond` call (line 586) loses its `workspaceId:` and `teachIntent:` arguments.

The teach-tag handling (lines 610-614) collapses to pointing-only:

```swift
                // Parse an optional trailing [POINT:...] tag. Teach routing now
                // happens entirely inside the sidecar's chat plane — the app
                // never sees a [TEACH:...] tag anymore.
                let parseResult = Self.parsePointingCoordinates(from: fullResponseText)
                let spokenText = parseResult.spokenText
```

And the teach kickoff block (lines 687-692) is deleted:

```swift
                // (deleted) if let teachTopicName = teachParseResult.topicName { ... }
```

Update the one other caller (`handleShortcutTransition` path passes just `transcript:` already — verify with `grep -n "sendTranscriptToClaudeWithScreenshot" leanring-buddy/CompanionManager.swift`).

- [ ] **Step 3: Add the dashboard opener and teachError speech**

Add near `openTerminalToSignIn` (line 199):

```swift
    /// Opens the static lessons dashboard the sidecar maintains at the lessons
    /// root. Falls back to the default install location when the sidecar has
    /// not reported a path yet (first launch before ready).
    func openLessonsDashboard() {
        let fallbackDashboardPath = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/OpenClicky Lessons/index.html")
            .path
        let dashboardPath = sidecarManager.lessonsDashboardPath ?? fallbackDashboardPath
        NSWorkspace.shared.open(URL(fileURLWithPath: dashboardPath))
    }
```

In `start()` (line 260), next to the existing `sidecarManager.onLessonCreated` wiring (line 272):

```swift
        sidecarManager.onTeachError = { [weak self] teachError in
            guard let self else { return }
            print("⚠️ Companion teach dispatch failed for \(teachError.topicName): \(teachError.message)")
            Task { @MainActor in
                try? await self.textToSpeechClient.speakText(
                    "hit a snag while building your \(teachError.topicName) lesson — mind trying that again?"
                )
            }
        }
```

- [ ] **Step 4: Verify by inspection and commit**

```bash
grep -n "selectedWorkspaceId\|teachIntent\|parseTeachIntent\|refreshWorkspaces\|requestNextLesson\|resetCurrentConversation" leanring-buddy/CompanionManager.swift
```
Expected: no matches.

```bash
git add leanring-buddy/CompanionManager.swift
git commit -m "Remove app-side topic routing; voice always rides the sidecar chat plane"
```

---

### Task 11: Panel UI — replace the topic picker with one Lessons button

**Files:**
- Modify: `leanring-buddy/CompanionPanelView.swift`

**Interfaces:**
- Consumes: `companionManager.openLessonsDashboard()` (Task 10).
- Produces: the panel section formerly `topicPickerSection` becomes `lessonsSection`.

- [ ] **Step 1: Remove the topic picker internals**

Delete: `topicActionButtons` (lines 917-929), `topicMenu` (lines 953-989), `hasNonGeneralTopics` (lines 947-951), `topicMenuLabel`/`selectedWorkspaceName` helpers (locate with `grep -n "selectedWorkspaceName\|topicMenuLabel" leanring-buddy/CompanionPanelView.swift`), and the first-run hint block inside `topicPickerSection`. Keep `topicActionButton(title:action:)` (lines 931-945) — the Lessons button reuses it.

- [ ] **Step 2: Replace `topicPickerSection` with `lessonsSection`**

```swift
    // MARK: - Lessons

    /// One button that opens the static lessons dashboard in the browser.
    /// Topics are managed entirely by voice ("teach me …"); lessons are found
    /// by navigation, not conversation.
    private var lessonsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Lessons")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                topicActionButton(title: "Open lessons") {
                    companionManager.openLessonsDashboard()
                }
            }

            Text("say \"teach me …\" to start a topic")
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.textTertiary)
        }
        .padding(.vertical, 4)
    }
```

Find the body reference and swap it:

```bash
grep -n "topicPickerSection" leanring-buddy/CompanionPanelView.swift
```

Replace the occurrence in the panel body with `lessonsSection`.

- [ ] **Step 3: Verify by inspection and commit**

```bash
grep -n "topicMenu\|selectedWorkspaceId\|workspaces\b\|requestNextLesson\|resetCurrentConversation" leanring-buddy/CompanionPanelView.swift
```
Expected: no matches.

`topicActionButton` already applies `.pointerCursor()` — the pointer-cursor convention holds.

```bash
git add leanring-buddy/CompanionPanelView.swift
git commit -m "Replace topic picker with a single Lessons dashboard button"
```

---

### Task 12: Documentation updates

**Files:**
- Modify: `CLAUDE.md` (project root)
- Modify: `docs/superpowers/specs/2026-07-08-chat-vs-learning-split-design.md` (status line)
- Modify: `leanring-buddy/sidecar/README.md` (drive:split, npm test)

- [ ] **Step 1: Update CLAUDE.md**

Per the self-update instructions: Architecture section — replace the "Stateful Learning" bullet's topic-picker/workspace-selection description with the chat-plane/dispatch model; update the sidecar request table (`chat` no longer carries workspaceId/teachIntent on the app path; `ready` carries dashboardPath; new `teachError` event); Key Files table — add `sidecar/src/teachTag.mjs`, `sidecar/src/topicRoster.mjs`, `sidecar/src/lessonsDashboard.mjs` rows with one-line purposes and approximate line counts, and refresh the line counts for `index.mjs`, `companionRules.mjs`, `workspaces.mjs`, `CompanionManager.swift`, `CompanionPanelView.swift` (>50-line drift rule).

- [ ] **Step 2: Update the spec status**

Change `Status: approved pending user review` to `Status: implemented 2026-07-09 (plan: docs/superpowers/plans/2026-07-09-chat-vs-learning-split.md)`.

- [ ] **Step 3: Update sidecar README**

Document `npm test` (unit) and `npm run drive:split -- --backend claude|codex` (live), and the `CLICKY_CHAT_IDLE_MS` knob.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-07-08-chat-vs-learning-split-design.md leanring-buddy/sidecar/README.md
git commit -m "Document the chat-vs-learning split"
```

---

### Task 13: Manual verification gate (user, Xcode)

**No terminal builds** (TCC). The user runs the app from Xcode (Cmd+R) with the console open. If the app runs the Application-Support sidecar install, either bump a file to trigger the hash-check reinstall or set the `clickySidecarDevPath` UserDefaults override to the repo's `leanring-buddy/sidecar` — otherwise the app runs the OLD sidecar.

- [ ] **Checklist (user-driven, console open):**
  1. Panel shows the "Lessons" section with "Open lessons"; no topic picker, no "Next lesson"/"New chat".
  2. Push-to-talk a general question → spoken answer; console shows `🗣️ Companion received transcript:` with the correct words (Task 1 check: say "teach me JavaScript" — verify "JavaScript" transcribes).
  3. "teach me <new topic>" → Clicky ASKS by voice before creating anything; say "yes" → spoken ack, chat stays responsive, lesson opens in the browser when ready.
  4. "add what's on my screen to my next <topic> lesson" with relevant content visible → ack, then a new numbered lesson arrives.
  5. "Open lessons" button → dashboard lists every topic and lesson, latest highlighted.
  6. Quit and relaunch the app → chat does NOT remember the previous conversation (ask "what did i just ask you?").
  7. Switch Brain to Codex and repeat step 3 with an existing topic → identical behavior on the Codex backend.
  8. Force a teach failure (e.g. rename a topic folder mid-dispatch) → spoken "hit a snag…" line, app stays alive.

- [ ] **On pass:** mark the plan complete. On any failure: file the symptom against the owning task and loop back.

---

## Self-review notes

- Spec coverage: chat plane (T5/T7), roster injection (T3/T7), extended tag + async dispatch + new-topic creation (T2/T7), spoken-confirmation rule (T6), idle/restart reset (T5/T7/T8), dashboard + watcher hook (T4/T7), panel changes (T11), error handling — teachError spoken (T7/T9/T10), malformed tag → plain speech (T2), roster-read failure degrades to no-roster turn (composeChatTurnText is total; listWorkspaces returns [] on missing root — covered); testing section (T2-T4 unit, T8 drive). Out-of-scope items untouched.
- The `general` workspace folder is not deleted from disk (existing installs keep it); it is simply never routed to, listed in the roster, or shown on the dashboard. This is deliberate — no data destruction.
- Type consistency: `dispatch.topicText`/`instructions` (T2) consumed by T7; `lessonsDashboardPath()` (T4) consumed by T7 ready event; `dashboardPath`/`topicName` SidecarEvent fields (T9) consumed by T9/T10; `openLessonsDashboard` (T10) consumed by T11.
