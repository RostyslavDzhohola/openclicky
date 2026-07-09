# Chat vs. Learning Split — Design

Date: 2026-07-08
Status: implemented 2026-07-09 (plan: docs/superpowers/plans/2026-07-09-chat-vs-learning-split.md)

## Vision

Clicky has two features that today share one mechanism, and the sharing causes the
confusion:

1. **Ephemeral voice chat** — Clicky shows you around: answers questions about what is
   on screen, points at things, helps in the moment. Disposable.
2. **Permanent learning** — when you want to keep a skill, it gets packaged into
   numbered HTML lessons (1, 2, 3, …) per topic, exactly as the teach skill defines.
   Persistent.

Today both are "workspaces" served by the same picker and session machinery
("general" is just another workspace). This design separates them into two planes
with one thin, backend-agnostic router between them.

## Decisions (from the interview)

- Voice always goes to ephemeral chat; the chat agent routes learning intents from
  the user's words plus the screenshot. There is no topic picker and no mode switch.
- "Add this to my next lesson" generates the next lesson **immediately** (no backlog
  queue), and finished lessons **open in the browser immediately**.
- Unknown topic → the agent **asks by voice first** ("I don't have a Japanese topic —
  want me to start one?") before creating anything.
- Chat memory is a **short conversation window**: the session resets after ~10 minutes
  of inactivity or on app restart. The "New chat" button is removed.
- Lessons are found by **navigation, not conversation**: a static local web page
  indexes all topics and lessons. The menu bar panel gets a single "Lessons" button.
- Routing uses the **extended tag protocol** (Approach A) so Claude and Codex backends
  behave identically.

## Architecture

### Chat plane (ephemeral)

- One chat session per backend, detached from workspace folders. The "general"
  workspace is removed; chat sessions run against an internal scratch directory
  that is never listed as a topic.
- The sidecar resets the chat session after ~10 minutes of inactivity and on app
  restart.
- **Topic roster injection:** every chat turn, the sidecar includes a compact roster
  read fresh from the lessons root — topic name/slug, lesson count, last lesson
  date. This is the agent's short memory of available lessons in scope. Rules in
  `companionRules.mjs` require the agent to target only rostered topics, so it can
  never write to a wrong or imagined folder, and to ask before starting a new topic.

### Learning plane (stateful)

- Topic workspaces are unchanged: separate folders under
  `~/Documents/OpenClicky Lessons/<topic-slug>/`, each with its own persistent teach
  session and `.clicky.json`. Lessons are numbered HTML files produced by the
  unmodified teach skill.
- The user never talks directly into a topic session. Topics are driven only by
  dispatched TEACH actions.

### The router: one tag

The existing `[TEACH:topic]` tag is extended to carry instructions:

```
[TEACH:topic-slug:instructions for this lesson]
```

All permanent-learning intents are this one tag with different instructions:

- "teach me Japanese" → `[TEACH:japanese:start the course from the basics]`
- "add this to my next lesson" (anime on screen) →
  `[TEACH:japanese:the user is watching anime with these phrases on screen — build
  them into the next lesson: …]`
- "continue my Japanese lessons" → `[TEACH:japanese:continue from lesson 4]`

Flow per turn:

1. Sidecar strips the tag; the app speaks the remaining text (e.g. "on it —
   building that into your next Japanese lesson"), so chat stays responsive.
2. Sidecar dispatches the instructions to the topic's teach session
   **asynchronously**; a minutes-long generation never blocks the chat plane.
3. When the lesson file lands, the existing chokidar `lessonCreated` event fires and
   the app opens the lesson in the browser immediately.

New-topic confirmation needs **no app-side state machine**: the agent asks in plain
speech, the short-window chat session remembers the exchange, and the user's "yes"
on the next push-to-talk turn produces the tag. If the tag names a topic not in the
roster, the sidecar creates the workspace (the prompt rules guarantee this only
happens after a spoken confirmation).

### Lessons dashboard (static)

- The sidecar regenerates a static `index.html` at the lessons root whenever a
  lesson or workspace changes (hooked into the existing watcher). It lists each
  topic's lessons 1…N as plain links, latest highlighted. No server, no model calls.
- Voice like "open my latest lesson" still works — the agent handles it
  conversationally — but clicking is the primary path.

### Menu bar panel changes

Removed: "Learning topic" picker, "New chat", "Next lesson", the topic first-run
hint. Added: one "Lessons" button that opens the dashboard `index.html`. Everything
else (voice status, backend picker, sign-in status, model picker, permissions,
feedback, quit) is unchanged.

## Error handling

- Teach generation failure → surfaced through the existing sidecar `error` events
  and spoken to the user.
- Malformed tag syntax (wrong shape, empty instructions) → treated as plain speech;
  nothing is dispatched. This is distinct from a well-formed tag naming a new topic,
  which creates the workspace (see the router section).
- Roster read failure → the turn proceeds without a roster and the rules instruct
  the agent to ask rather than guess topic names.

## Testing

Extend the terminal drive harness (`sidecar/test/drive.mjs`), which speaks the app's
real protocol without Xcode:

- roster injection: a chat turn's context contains exactly the on-disk topics
- TEACH dispatch: tag → async generation in the right topic folder → `lessonCreated`
- new-topic flow: unknown slug in a tag creates the workspace
- idle reset: chat context is gone after the inactivity window
- dashboard: `index.html` regenerates after a lesson lands and links every lesson

## Out of scope

- No changes to the teach skill itself, lesson file format, `[POINT:...]` pointing,
  transcription, or TTS.
- No native dashboard window, no localhost server, no lesson-material backlog queue.
