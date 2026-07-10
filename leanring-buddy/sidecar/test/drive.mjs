#!/usr/bin/env node
// Terminal test harness for the sidecar. Spawns `node index.mjs` and speaks
// the exact NDJSON protocol the macOS app uses, so every backend feature can
// be verified without building the app (Xcode builds must not run from the
// terminal — they invalidate TCC permissions).
//
// Usage:
//   node test/drive.mjs chat   [--backend claude|codex] [--text "..."] [--image path] [--workspace id] [--real]
//   node test/drive.mjs oneshot [--backend ...] [--image path]
//   node test/drive.mjs teach  [--backend ...] [--topic "css flexbox basics"] [--real]
//   node test/drive.mjs auth
//   node test/drive.mjs workspaces
//   node test/drive.mjs resume [--backend ...]   (two sidecar processes, proves continuity)
//   node test/drive.mjs split  [--backend ...]   (chat dispatch + background lesson creation)
//   node test/drive.mjs interview [--backend ...] (topic interview + lesson build)
//
// By default all state goes to throwaway dirs under $TMPDIR (clicky-drive-*).
// Pass --real to use the real ~/Documents/OpenClicky Lessons + Application Support.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { chatModelForBackend } from "./chatModelForBackend.mjs";

const sidecarDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const commandLineArguments = process.argv.slice(2);
const subcommand = commandLineArguments[0] ?? "chat";

function flagValue(flagName, defaultValue) {
  const flagIndex = commandLineArguments.indexOf(flagName);
  if (flagIndex === -1 || flagIndex + 1 >= commandLineArguments.length) {
    return defaultValue;
  }
  return commandLineArguments[flagIndex + 1];
}

const useRealDirectories = commandLineArguments.includes("--real");
const backend = flagValue("--backend", "claude");
const workspaceId = flagValue("--workspace", "general");

const driveEnvironment = { ...process.env };
if (!useRealDirectories) {
  // Fresh directories per drive run: a fixed path leaks workspace state
  // (lessons, session ids) between runs, and a dispatched teach turn that
  // finds its lesson already on disk creates nothing — so lessonCreated
  // never fires and stateful modes like split hang to timeout.
  const lessonsRoot = mkdtempSync(join(tmpdir(), "clicky-drive-lessons-"));
  const appSupport = mkdtempSync(join(tmpdir(), "clicky-drive-support-"));
  driveEnvironment.CLICKY_LESSONS_ROOT = lessonsRoot;
  driveEnvironment.CLICKY_APP_SUPPORT = appSupport;
  driveEnvironment.CLICKY_CHAT_IDLE_MS = process.env.CLICKY_CHAT_IDLE_MS ?? "3000";
  console.log(`[drive] lessons root: ${lessonsRoot}`);
}

class SidecarProcess {
  constructor() {
    this.child = spawn("node", ["index.mjs"], {
      cwd: sidecarDirectory,
      env: driveEnvironment,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.eventWaiters = [];
    this.allEvents = [];
    this.intentionallyStopped = false;
    this.exited = new Promise((resolveExit) => {
      this.child.once("exit", resolveExit);
    });
    this.child.on("error", (error) => {
      console.error(`[drive] failed to spawn sidecar: ${error.message}`);
      process.exit(1);
    });
    this.child.on("exit", () => {
      // Any exit we didn't ask for is a failure, even while idle — a crash
      // between commands would otherwise surface only as a later timeout.
      if (!this.intentionallyStopped) {
        console.error("[drive] sidecar exited unexpectedly");
        process.exit(1);
      }
    });
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        console.log(`[drive] unparseable stdout line: ${line}`);
        return;
      }
      console.log(`[event] ${JSON.stringify(event)}`);
      this.allEvents.push(event);
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.predicate(event)) {
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
  }

  send(request) {
    console.log(`[send]  ${JSON.stringify(request)}`);
    this.child.stdin.write(JSON.stringify(request) + "\n");
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutHandle = setTimeout(
        () => rejectPromise(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      this.eventWaiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timeoutHandle);
          resolvePromise(event);
        },
      });
    });
  }

  hasLogEventContaining(substring) {
    return this.allEvents.some(
      (event) => event.type === "log" && String(event.message ?? "").includes(substring)
    );
  }

  /** Resolves with the result/error event matching the request id. */
  waitForCompletion(requestId, timeoutMs) {
    return this.waitFor(
      (event) => event.id === requestId && (event.type === "result" || event.type === "error"),
      timeoutMs
    );
  }

  async stop() {
    this.intentionallyStopped = true;
    this.child.stdin.end();
    // Bounded shutdown: a sidecar that ignores stdin EOF must not hang the
    // whole drive — kill it and still wait for the exit event.
    const shutdownTimeoutMs = 10_000;
    await Promise.race([
      this.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`sidecar did not exit within ${shutdownTimeoutMs}ms`)), shutdownTimeoutMs)
      ),
    ]).catch((timeoutError) => {
      console.error(`[drive] ${timeoutError.message}; killing sidecar`);
      this.child.kill("SIGKILL");
      return this.exited;
    });
  }
}

function assertCondition(condition, failureMessage) {
  if (!condition) {
    console.error(`\n[FAIL] ${failureMessage}`);
    process.exit(1);
  }
}

async function startSidecar() {
  const sidecar = new SidecarProcess();
  const readyEvent = await sidecar.waitFor((event) => event.type === "ready", 15_000);
  sidecar.lessonsRoot = readyEvent.lessonsRoot;
  return sidecar;
}

let nextRequestNumber = 1;
function newRequestId() {
  return `drive-${nextRequestNumber++}`;
}

function buildImages() {
  const imagePath = flagValue("--image", null);
  if (!imagePath) return [];
  return [
    {
      path: resolve(imagePath),
      label: "Screen 1 (primary focus, cursor screen) (image dimensions: 1280x800 pixels)",
    },
  ];
}

async function runChatDrive() {
  const sidecar = await startSidecar();
  const requestId = newRequestId();
  sidecar.send({
    id: requestId,
    type: "chat",
    backend,
    workspaceId,
    model: chatModelForBackend(backend),
    text: flagValue("--text", "in one short sentence, what do you see on my screen?"),
    images: buildImages(),
    teachIntent: false,
  });
  const completion = await sidecar.waitForCompletion(requestId, 300_000);
  assertCondition(completion.type === "result", `chat failed: ${completion.message}`);
  assertCondition(
    typeof completion.text === "string" && completion.text.trim().length > 0,
    "chat returned empty text"
  );
  console.log(`\n[PASS] ${backend} chat responded (${completion.durationMs}ms):\n${completion.text}`);
  await sidecar.stop();
}

async function runOneShotDrive() {
  const sidecar = await startSidecar();
  const requestId = newRequestId();
  sidecar.send({
    id: requestId,
    type: "oneShot",
    backend,
    text: "look at this screen and make one short quirky comment about something you can see.",
    images: buildImages(),
    systemPrompt:
      "you are a playful screen commentator. reply with one lowercase sentence only.",
  });
  const completion = await sidecar.waitForCompletion(requestId, 180_000);
  assertCondition(completion.type === "result", `oneShot failed: ${completion.message}`);
  assertCondition(completion.text.trim().length > 0, "oneShot returned empty text");
  console.log(`\n[PASS] ${backend} oneShot responded:\n${completion.text}`);
  await sidecar.stop();
}

async function runAuthDrive() {
  const sidecar = await startSidecar();
  const requestId = newRequestId();
  sidecar.send({ id: requestId, type: "authStatus" });
  const completion = await sidecar.waitForCompletion(requestId, 30_000);
  assertCondition(completion.type === "result", "authStatus failed");
  console.log(
    `\n[PASS] auth — claude: ${completion.claude.loggedIn} (${completion.claude.method}), codex: ${completion.codex.loggedIn}, teach skill: ${JSON.stringify(completion.teachSkill)}`
  );
  await sidecar.stop();
}

async function runWorkspacesDrive() {
  const sidecar = await startSidecar();
  const createId = newRequestId();
  sidecar.send({ id: createId, type: "createWorkspace", name: "Drive Test Topic" });
  const createCompletion = await sidecar.waitForCompletion(createId, 240_000);
  assertCondition(
    createCompletion.type === "result",
    `createWorkspace failed: ${createCompletion.message}`
  );
  console.log(`[drive] created: ${JSON.stringify(createCompletion.workspace)}`);

  const listId = newRequestId();
  sidecar.send({ id: listId, type: "listWorkspaces" });
  const listCompletion = await sidecar.waitForCompletion(listId, 30_000);
  assertCondition(
    listCompletion.workspaces.some((workspace) => workspace.id === "drive-test-topic"),
    "created workspace missing from list"
  );
  console.log(`\n[PASS] workspaces: ${listCompletion.workspaces.map((w) => w.id).join(", ")}`);
  await sidecar.stop();
}

async function runTeachDrive() {
  const sidecar = await startSidecar();
  const topicName = flagValue("--topic", "css flexbox basics");

  const createId = newRequestId();
  sidecar.send({ id: createId, type: "createWorkspace", name: topicName });
  const createCompletion = await sidecar.waitForCompletion(createId, 240_000);
  assertCondition(
    createCompletion.type === "result",
    `createWorkspace failed: ${createCompletion.message}`
  );
  const workspace = createCompletion.workspace;
  console.log(`[drive] workspace ready: ${workspace.path}`);

  const lessonCreatedPromise = sidecar.waitFor(
    (event) => event.type === "lessonCreated" && event.workspaceId === workspace.id,
    600_000
  );

  const chatId = newRequestId();
  sidecar.send({
    id: chatId,
    type: "chat",
    backend,
    workspaceId: workspace.id,
    text: `${topicName}. my mission: i want a quick practical introduction. i am a complete beginner. success is understanding the core concepts. teach me the first lesson now — do not ask me clarifying questions, make reasonable assumptions and create the first lesson.`,
    images: [],
    teachIntent: true,
  });

  const chatCompletion = await sidecar.waitForCompletion(chatId, 600_000);
  assertCondition(chatCompletion.type === "result", `teach chat failed: ${chatCompletion.message}`);
  console.log(`\n[drive] teach turn finished:\n${chatCompletion.text}\n`);

  const lessonEvent = await lessonCreatedPromise;
  console.log(
    `\n[PASS] lesson created at ${lessonEvent.path} (openedByAgent: ${lessonEvent.openedByAgent})`
  );
  await sidecar.stop();
}

async function runResumeDrive() {
  const firstSidecar = await startSidecar();
  const firstId = newRequestId();
  const memorablePhrase = `banana-${Date.now()}`;
  firstSidecar.send({
    id: firstId,
    type: "chat",
    backend,
    workspaceId: "general",
    text: `remember this codeword for later: ${memorablePhrase}. reply with one word: ok.`,
    images: [],
  });
  const firstCompletion = await firstSidecar.waitForCompletion(firstId, 300_000);
  assertCondition(firstCompletion.type === "result", `first turn failed: ${firstCompletion.message}`);
  await firstSidecar.stop();

  const secondSidecar = await startSidecar();
  const secondId = newRequestId();
  secondSidecar.send({
    id: secondId,
    type: "chat",
    backend,
    workspaceId: "general",
    text: "what was the codeword i asked you to remember? reply with the codeword only.",
    images: [],
  });
  const secondCompletion = await secondSidecar.waitForCompletion(secondId, 300_000);
  assertCondition(secondCompletion.type === "result", `second turn failed: ${secondCompletion.message}`);
  assertCondition(
    secondCompletion.text.includes(memorablePhrase.split("-")[0]),
    `resume failed — codeword missing from: ${secondCompletion.text}`
  );
  console.log(`\n[PASS] ${backend} session resumed across sidecar restart:\n${secondCompletion.text}`);
  await secondSidecar.stop();
}

async function runSplitDrive() {
  const sidecar = await startSidecar();

  const createRequestId = newRequestId();
  sidecar.send({ id: createRequestId, type: "createWorkspace", name: "drive split topic" });
  const createCompletion = await sidecar.waitForCompletion(createRequestId, 120_000);
  assertCondition(
    createCompletion.type === "result",
    "createWorkspace failed: " + (createCompletion.message ?? "")
  );
  assertCondition(
    createCompletion.workspace?.id === "drive-split-topic",
    "unexpected workspace id: " + (createCompletion.workspace?.id ?? "none")
  );

  // Since interview mode shipped, a mission-less topic would route this
  // drive's forced tag into a voice interview. This scenario tests the
  // immediate-dispatch path, so satisfy the mission check up front.
  writeFileSync(
    join(sidecar.lessonsRoot, "drive-split-topic", "MISSION.md"),
    "# mission\nstub mission so the split drive exercises the immediate dispatch path\n"
  );

  // 1. Chat-plane turn instructed to emit the extended tag verbatim, so the
  //    routing is tested without depending on the model's own intent detection.
  //    The topic must pre-exist because companion rules forbid tagging
  //    unrostered topics; ask-before-create would otherwise intercept.
  const chatRequestId = newRequestId();
  sidecar.send({
    id: chatRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text:
      'this is a routing test. the topic drive-split-topic already exists in your roster. reply with one short sentence and end your reply with exactly this tag, verbatim: [TEACH:drive-split-topic:create a one-page hello lesson that says hello world]',
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
  const dashboardHtml = readFileSync(join(sidecar.lessonsRoot, "index.html"), "utf8");
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

async function runInterviewDrive() {
  // The sandbox default of 3 seconds would reset the ephemeral chat session
  // between interview turns and break tag-confirmation context.
  driveEnvironment.CLICKY_CHAT_IDLE_MS = "120000";

  const sidecar = await startSidecar();

  const initialChatRequestId = newRequestId();
  sidecar.send({
    id: initialChatRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text: "teach me celestial navigation",
    images: [],
  });
  const initialChatCompletion = await sidecar.waitForCompletion(initialChatRequestId, 300_000);
  assertCondition(initialChatCompletion.type === "result", `initial chat failed: ${initialChatCompletion.message}`);
  assertCondition(
    typeof initialChatCompletion.text === "string" && initialChatCompletion.text.trim().length > 0,
    "initial chat returned empty text"
  );
  assertCondition(!initialChatCompletion.text.includes("[TEACH"), "initial chat leaked a TEACH tag");
  // This asserts model behavior, so it is probabilistic by design, like the rest of the drive.
  assertCondition(initialChatCompletion.text.includes("?"), "ask-before-create did not ask a question");
  assertCondition(!sidecar.hasLogEventContaining("teach dispatch →"), "lesson build dispatched before confirmation");

  const confirmationChatRequestId = newRequestId();
  sidecar.send({
    id: confirmationChatRequestId,
    type: "chat",
    backend,
    model: chatModelForBackend(backend),
    effort: "low",
    text: "yes, start the course",
    images: [],
  });
  const confirmationChatCompletion = await sidecar.waitForCompletion(confirmationChatRequestId, 600_000);
  assertCondition(confirmationChatCompletion.type === "result", `confirmation chat failed: ${confirmationChatCompletion.message}`);
  assertCondition(
    typeof confirmationChatCompletion.text === "string" && confirmationChatCompletion.text.trim().length > 0,
    "confirmation chat returned empty text"
  );
  assertCondition(!confirmationChatCompletion.text.includes("[TEACH"), "confirmation chat leaked a TEACH tag");
  assertCondition(!sidecar.hasLogEventContaining("teach dispatch →"), "lesson build dispatched during interview start");

  const matchingTopicWorkspaceDirectories = readdirSync(sidecar.lessonsRoot, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isDirectory() && !directoryEntry.name.startsWith(".") && directoryEntry.name.includes("celestial"))
    .map((directoryEntry) => directoryEntry.name);
  // The chat agent picks the slug, so match loosely.
  assertCondition(matchingTopicWorkspaceDirectories.length === 1, "expected exactly one celestial topic workspace");
  const topicWorkspaceDirectory = join(sidecar.lessonsRoot, matchingTopicWorkspaceDirectories[0]);

  const scriptedInterviewAnswers = [
    "i want to sail across the atlantic without gps. i am a complete beginner.",
    "success means i can plot a position fix with a sextant on a real ocean passage.",
    "no other constraints. you have everything you need — write the mission now.",
    "nothing else to add. please write MISSION.md now.",
  ];

  for (const scriptedInterviewAnswer of scriptedInterviewAnswers) {
    const interviewAnswerRequestId = newRequestId();
    sidecar.send({
      id: interviewAnswerRequestId,
      type: "chat",
      backend,
      model: chatModelForBackend(backend),
      effort: "low",
      text: scriptedInterviewAnswer,
      images: [],
    });
    const interviewAnswerCompletion = await sidecar.waitForCompletion(interviewAnswerRequestId, 600_000);
    assertCondition(interviewAnswerCompletion.type === "result", `interview answer failed: ${interviewAnswerCompletion.message}`);
    if (existsSync(join(topicWorkspaceDirectory, "MISSION.md"))) {
      break;
    }
  }
  assertCondition(existsSync(join(topicWorkspaceDirectory, "MISSION.md")), "interview never produced MISSION.md");

  const missionFileContents = readFileSync(join(topicWorkspaceDirectory, "MISSION.md"), "utf8");
  assertCondition(missionFileContents.length > 0, "MISSION.md is empty");
  assertCondition(/(atlantic|gps|sextant|navigat)/i.test(missionFileContents), "MISSION.md did not capture interview answers");

  if (!sidecar.hasLogEventContaining("teach dispatch →")) {
    await sidecar.waitFor(
      (event) => event.type === "log" && String(event.message ?? "").includes("teach dispatch →"),
      60_000
    );
  }
  await sidecar.waitFor(
    (event) => event.type === "lessonCreated" && event.workspaceId === basename(topicWorkspaceDirectory),
    600_000
  );

  console.log("\n[PASS] interview ran, mission captured, lesson built");
  await sidecar.stop();
}

const driveSubcommands = {
  chat: runChatDrive,
  oneshot: runOneShotDrive,
  auth: runAuthDrive,
  workspaces: runWorkspacesDrive,
  teach: runTeachDrive,
  resume: runResumeDrive,
  split: runSplitDrive,
  interview: runInterviewDrive,
};

const selectedDrive = driveSubcommands[subcommand];
if (!selectedDrive) {
  console.error(`unknown subcommand "${subcommand}" — one of: ${Object.keys(driveSubcommands).join(", ")}`);
  process.exit(1);
}

selectedDrive().catch((driveError) => {
  console.error(`\n[FAIL] ${driveError?.message ?? driveError}`);
  process.exit(1);
});
