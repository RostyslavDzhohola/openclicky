#!/usr/bin/env node
// Four-way teach-skill comparison harness. This intentionally checks only the
// resulting workspace structure because lesson content is LLM-generated and
// expected to vary across runs.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const sidecarDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandLineArguments = process.argv.slice(2);
const keepArtifacts = commandLineArguments.includes("--keep");
const missionText =
  "spanish for travel. my mission: i want practical spanish for traveling. i am a complete beginner. success is holding simple travel conversations. teach me the first lesson now — do not ask me clarifying questions, make reasonable assumptions and create the first lesson.";
const comparisonRoot = join(tmpdir(), `clicky-compare-${Date.now()}`);
const cachedTeachTemplateSupportDirectory = join(tmpdir(), "clicky-drive-support");
const tenMinutesMs = 600_000;

const runDefinitions = [
  {
    name: "sidecar-claude",
    workspaceDirectory: join(comparisonRoot, "sidecar-claude", "spanish-for-travel"),
  },
  {
    name: "sidecar-codex",
    workspaceDirectory: join(comparisonRoot, "sidecar-codex", "spanish-for-travel"),
  },
  {
    name: "plain-claude",
    workspaceDirectory: join(comparisonRoot, "plain-claude"),
  },
  {
    name: "plain-codex",
    workspaceDirectory: join(comparisonRoot, "plain-codex"),
  },
];

function logWithRunName(runName, message) {
  const lines = String(message).split(/\r?\n/);
  for (const line of lines) {
    if (line.length > 0) {
      console.log(`[${runName}] ${line}`);
    }
  }
}

function logProcessChunk(runName, chunk) {
  logWithRunName(runName, chunk.toString().replace(/\r?\n$/, ""));
}

function newRequestId(runName, suffix) {
  return `${runName}-${suffix}-${Date.now()}`;
}

function chatModelForBackend(backend) {
  return backend === "claude" ? "claude-sonnet-4-6" : "default";
}

class SidecarProcess {
  constructor(runName, sidecarEnvironment) {
    this.runName = runName;
    this.eventWaiters = [];
    this.intentionallyStopped = false;
    this.child = spawn("node", ["index.mjs"], {
      cwd: sidecarDirectory,
      env: sidecarEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolveExit) => {
      this.child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    this.child.on("error", (error) => {
      this.rejectAllWaiters(new Error(`failed to spawn sidecar: ${error.message}`));
    });
    this.child.on("exit", (exitCode, signal) => {
      if (!this.intentionallyStopped) {
        this.rejectAllWaiters(
          new Error(`sidecar exited unexpectedly with code ${exitCode ?? "null"} signal ${signal ?? "null"}`)
        );
      }
    });
    this.child.stderr.on("data", (chunk) => logProcessChunk(this.runName, chunk));
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        logWithRunName(this.runName, `unparseable stdout line: ${line}`);
        return;
      }
      logWithRunName(this.runName, `[event] ${JSON.stringify(event)}`);
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.predicate(event)) {
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
  }

  send(request) {
    logWithRunName(this.runName, `[send] ${JSON.stringify(request)}`);
    this.child.stdin.write(JSON.stringify(request) + "\n");
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        resolve: (event) => {
          clearTimeout(timeoutHandle);
          resolvePromise(event);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          rejectPromise(error);
        },
      };
      const timeoutHandle = setTimeout(() => {
        this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
        rejectPromise(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  waitForCompletion(requestId, timeoutMs) {
    return this.waitFor(
      (event) => event.id === requestId && (event.type === "result" || event.type === "error"),
      timeoutMs
    );
  }

  rejectAllWaiters(error) {
    for (const waiter of this.eventWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async stop() {
    this.intentionallyStopped = true;
    this.child.stdin.end();
    const shutdownTimeoutMs = 10_000;
    await Promise.race([
      this.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`sidecar did not exit within ${shutdownTimeoutMs}ms`)), shutdownTimeoutMs)
      ),
    ]).catch((timeoutError) => {
      logWithRunName(this.runName, `${timeoutError.message}; killing sidecar`);
      this.child.kill("SIGKILL");
      return this.exited;
    });
  }
}

async function runSidecarTeachComparison(runName, backend) {
  const lessonsRoot = join(comparisonRoot, runName);
  mkdirSync(lessonsRoot, { recursive: true });
  mkdirSync(cachedTeachTemplateSupportDirectory, { recursive: true });
  const sidecarEnvironment = {
    ...process.env,
    CLICKY_LESSONS_ROOT: lessonsRoot,
    CLICKY_APP_SUPPORT: cachedTeachTemplateSupportDirectory,
  };
  const sidecar = new SidecarProcess(runName, sidecarEnvironment);
  try {
    await sidecar.waitFor((event) => event.type === "ready", 15_000);
    const createWorkspaceRequestId = newRequestId(runName, "create");
    sidecar.send({
      id: createWorkspaceRequestId,
      type: "createWorkspace",
      name: "spanish for travel",
    });
    const createWorkspaceCompletion = await sidecar.waitForCompletion(createWorkspaceRequestId, 240_000);
    if (createWorkspaceCompletion.type !== "result") {
      throw new Error(`createWorkspace failed: ${createWorkspaceCompletion.message}`);
    }
    logWithRunName(runName, `workspace ready: ${createWorkspaceCompletion.workspace?.path ?? lessonsRoot}`);

    const chatRequestId = newRequestId(runName, "chat");
    sidecar.send({
      id: chatRequestId,
      type: "chat",
      backend,
      workspaceId: "spanish-for-travel",
      model: chatModelForBackend(backend),
      text: missionText,
      images: [],
      teachIntent: true,
    });
    const chatCompletion = await sidecar.waitForCompletion(chatRequestId, tenMinutesMs);
    if (chatCompletion.type !== "result") {
      throw new Error(`teach chat failed: ${chatCompletion.message}`);
    }
    logWithRunName(runName, `teach turn finished in ${chatCompletion.durationMs ?? "unknown"}ms`);
    return { runName, workspaceDirectory: join(lessonsRoot, "spanish-for-travel") };
  } finally {
    await sidecar.stop();
  }
}

function runCommand(runName, command, args, cwd, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    logWithRunName(runName, `$ ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combinedOutput = "";
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      combinedOutput += chunk.toString();
      logProcessChunk(runName, chunk);
    });
    child.stderr.on("data", (chunk) => {
      combinedOutput += chunk.toString();
      logProcessChunk(runName, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      rejectPromise(new Error(`failed to spawn ${command}: ${error.message}`));
    });
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      if (exitCode === 0) {
        resolvePromise({ combinedOutput });
        return;
      }
      const outputTail = combinedOutput.trim().split(/\r?\n/).slice(-20).join("\n");
      rejectPromise(
        new Error(`${command} exited with code ${exitCode ?? "null"} signal ${signal ?? "null"}\n${outputTail}`)
      );
    });
  });
}

async function runPlainTeachComparison(runName, agentName, command, args) {
  const workspaceDirectory = join(comparisonRoot, runName);
  mkdirSync(workspaceDirectory, { recursive: true });
  await runCommand(
    runName,
    "npx",
    ["-y", "skills@latest", "add", "mattpocock/skills", "--skill", "teach", "--agent", agentName, "-y", "--copy"],
    workspaceDirectory,
    tenMinutesMs
  );
  await runCommand(runName, command, args, workspaceDirectory, tenMinutesMs);
  return { runName, workspaceDirectory };
}

function countHeadingLines(filePath) {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line)).length;
}

function readFirstLine(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8").split(/\r?\n/)[0] ?? "";
}

function countQuizReferences(filePath) {
  if (!existsSync(filePath)) return 0;
  const matches = readFileSync(filePath, "utf8").match(/quiz/gi);
  return matches?.length ?? 0;
}

function findSkillPath(workspaceDirectory) {
  const agentsSkillPath = join(workspaceDirectory, ".agents", "skills", "teach", "SKILL.md");
  if (existsSync(agentsSkillPath)) return agentsSkillPath;
  const claudeSkillPath = join(workspaceDirectory, ".claude", "skills", "teach", "SKILL.md");
  if (existsSync(claudeSkillPath)) return claudeSkillPath;
  return null;
}

function sha256File(filePath) {
  if (!filePath) return "";
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function analyzeWorkspace(runDefinition, settledResult) {
  const workspaceDirectory = runDefinition.workspaceDirectory;
  const missionPath = join(workspaceDirectory, "MISSION.md");
  const resourcesPath = join(workspaceDirectory, "RESOURCES.md");
  const lessonsDirectory = join(workspaceDirectory, "lessons");
  const lessonFiles = existsSync(lessonsDirectory)
    ? readdirSync(lessonsDirectory)
        .filter((fileName) => fileName.endsWith(".html"))
        .sort()
    : [];
  const correctlyNamedLessonFiles = lessonFiles.filter((fileName) => /^\d{4}-[a-z0-9-]+\.html$/.test(fileName));
  const incorrectlyNamedLessonFiles = lessonFiles.filter(
    (fileName) => !correctlyNamedLessonFiles.includes(fileName)
  );
  const lessonDetails = correctlyNamedLessonFiles.map((fileName) => {
    const lessonPath = join(lessonsDirectory, fileName);
    return {
      fileName,
      sizeBytes: statSync(lessonPath).size,
      quizReferenceCount: countQuizReferences(lessonPath),
    };
  });
  const skillPath = findSkillPath(workspaceDirectory);
  const skillSha = sha256File(skillPath);
  const failedReason =
    settledResult.status === "rejected" ? settledResult.reason?.message ?? String(settledResult.reason) : "";

  return {
    runName: runDefinition.name,
    workspaceDirectory,
    failedReason,
    missionPresent: existsSync(missionPath),
    missionFirstLine: readFirstLine(missionPath),
    missionHeadingCount: countHeadingLines(missionPath),
    resourcesPresent: existsSync(resourcesPath),
    lessonDetails,
    incorrectlyNamedLessonFiles,
    hasCorrect0001Lesson: correctlyNamedLessonFiles.some((fileName) => fileName.startsWith("0001-")),
    lessonNamingOk: lessonFiles.length > 0 && lessonFiles.length === correctlyNamedLessonFiles.length,
    referencePresent: existsSync(join(workspaceDirectory, "reference")),
    learningRecordsPresent: existsSync(join(workspaceDirectory, "learning-records")),
    assetsPresent: existsSync(join(workspaceDirectory, "assets")),
    notesPresent: existsSync(join(workspaceDirectory, "NOTES.md")),
    skillSha,
  };
}

function printWorkspaceReport(analysis) {
  console.log(`\n[report] ${analysis.runName}`);
  console.log(`[report] workspace: ${analysis.workspaceDirectory}`);
  if (analysis.failedReason) {
    console.log(`[report] run error: ${analysis.failedReason}`);
  }
  console.log(
    `[report] MISSION.md: ${analysis.missionPresent ? "present" : "missing"} | first line: ${analysis.missionFirstLine || "(none)"} | headings: ${analysis.missionHeadingCount}`
  );
  console.log(`[report] RESOURCES.md: ${analysis.resourcesPresent ? "present" : "missing"}`);
  if (analysis.lessonDetails.length === 0) {
    console.log("[report] lessons/: no correctly named lesson files found");
  } else {
    for (const lessonDetail of analysis.lessonDetails) {
      console.log(
        `[report] lessons/${lessonDetail.fileName}: ${lessonDetail.sizeBytes} bytes | quiz refs: ${lessonDetail.quizReferenceCount}`
      );
    }
  }
  if (analysis.incorrectlyNamedLessonFiles.length > 0) {
    console.log(`[report] lessons/ invalid names: ${analysis.incorrectlyNamedLessonFiles.join(", ")}`);
  }
  console.log(`[report] reference/: ${analysis.referencePresent ? "present" : "missing"}`);
  console.log(`[report] learning-records/: ${analysis.learningRecordsPresent ? "present" : "missing"}`);
  console.log(`[report] assets/: ${analysis.assetsPresent ? "present" : "missing"}`);
  console.log(`[report] NOTES.md: ${analysis.notesPresent ? "present" : "missing"}`);
  console.log(`[report] teach SKILL.md sha256: ${analysis.skillSha || "(missing)"}`);

  // Explicit enclosing-folder completeness check against the full set of
  // artifacts a finished teach run is expected to leave behind.
  const expectedArtifacts = [
    ["MISSION.md", analysis.missionPresent],
    ["RESOURCES.md", analysis.resourcesPresent],
    ["lessons/0001-*.html", analysis.hasCorrect0001Lesson],
    ["reference/", analysis.referencePresent],
    ["learning-records/", analysis.learningRecordsPresent],
    ["assets/", analysis.assetsPresent],
    ["NOTES.md", analysis.notesPresent],
    ["teach SKILL.md", Boolean(analysis.skillSha)],
  ];
  const missingArtifacts = expectedArtifacts.filter(([, present]) => !present).map(([name]) => name);
  if (missingArtifacts.length === 0) {
    console.log(`[report] artifacts: COMPLETE — all ${expectedArtifacts.length} expected artifacts present`);
  } else {
    console.log(`[report] artifacts: INCOMPLETE — missing: ${missingArtifacts.join(", ")}`);
  }
}

function formatTableCell(value, width) {
  return String(value).padEnd(width, " ");
}

function printVerdictTable(analyses) {
  const columns = [
    ["run", 15],
    ["MISSION", 9],
    ["RESOURCES", 10],
    ["lesson-0001", 12],
    ["naming-ok", 10],
    ["skill-sha-prefix", 16],
  ];
  console.log("\n[verdict]");
  console.log(columns.map(([label, width]) => formatTableCell(label, width)).join(" | "));
  console.log(columns.map(([, width]) => "-".repeat(width)).join("-+-"));
  for (const analysis of analyses) {
    console.log(
      [
        formatTableCell(analysis.runName, 15),
        formatTableCell(analysis.missionPresent ? "yes" : "no", 9),
        formatTableCell(analysis.resourcesPresent ? "yes" : "no", 10),
        formatTableCell(analysis.hasCorrect0001Lesson ? "yes" : "no", 12),
        formatTableCell(analysis.lessonNamingOk ? "yes" : "no", 10),
        formatTableCell(analysis.skillSha ? analysis.skillSha.slice(0, 12) : "(missing)", 16),
      ].join(" | ")
    );
  }
}

function cleanupPath(pathToRemove) {
  if (!existsSync(pathToRemove)) return;
  rmSync(pathToRemove, { recursive: true, force: true });
  console.log(`[cleanup] removed ${pathToRemove}`);
}

function cleanupArtifacts() {
  if (keepArtifacts) {
    console.log("[cleanup] --keep set; skipping all cleanup");
    return;
  }
  cleanupPath(comparisonRoot);
  for (const staleRoot of [
    join(tmpdir(), "clicky-drive-lessons"),
    join(tmpdir(), "clicky-continue-test"),
    "/tmp/vanilla-claude-teach",
    "/tmp/vanilla-codex-teach",
    "/tmp/skills-flag-test",
    "/tmp/clicky-fresh-root",
    "/tmp/chokidar-test",
  ]) {
    cleanupPath(staleRoot);
  }
  // Keep $TMPDIR/clicky-drive-support intact; it caches the teach template and
  // avoids reinstalling it on every sidecar comparison run.
  console.log(`[cleanup] kept cached teach template support ${cachedTeachTemplateSupportDirectory}`);
}

async function main() {
  mkdirSync(comparisonRoot, { recursive: true });
  console.log(`[compare] root: ${comparisonRoot}`);
  console.log("[compare] starting four teach runs concurrently");

  // The two claude runs go fully in parallel. The two codex runs must NOT
  // overlap: both authenticate against the single ~/.codex/auth.json login,
  // and a concurrent OAuth token refresh makes one run's in-flight token 401.
  // So we serialize the codex runs relative to each other (still concurrent
  // with the claude runs) to keep the comparison fair.
  const startedSidecarClaude = runSidecarTeachComparison("sidecar-claude", "claude");
  const startedPlainClaude = runPlainTeachComparison("plain-claude", "claude-code", "claude", [
    "--dangerously-skip-permissions",
    "-p",
    `/teach ${missionText}`,
  ]);

  const settleRun = (runPromise) =>
    runPromise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );

  const startedCodexChain = (async () => {
    const sidecarCodexOutcome = await settleRun(
      runSidecarTeachComparison("sidecar-codex", "codex")
    );
    const plainCodexOutcome = await settleRun(
      runPlainTeachComparison("plain-codex", "codex", "codex", [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
        `$teach ${missionText}`,
      ])
    );
    return { sidecarCodexOutcome, plainCodexOutcome };
  })();

  const [sidecarClaudeOutcome, plainClaudeOutcome, codexChainOutcomes] = await Promise.all([
    settleRun(startedSidecarClaude),
    settleRun(startedPlainClaude),
    startedCodexChain,
  ]);

  // Rebuild the settled array in the same order as runDefinitions:
  // [sidecar-claude, sidecar-codex, plain-claude, plain-codex].
  const settledResults = [
    sidecarClaudeOutcome,
    codexChainOutcomes.sidecarCodexOutcome,
    plainClaudeOutcome,
    codexChainOutcomes.plainCodexOutcome,
  ];
  const analyses = runDefinitions.map((runDefinition, index) =>
    analyzeWorkspace(runDefinition, settledResults[index])
  );
  for (const analysis of analyses) {
    printWorkspaceReport(analysis);
  }
  printVerdictTable(analyses);
  console.log(
    "\n[compare] note: lesson CONTENT is expected to differ run-to-run because of LLM nondeterminism; this harness asserts only structure and behavior."
  );

  // When artifacts are kept, print an easy-to-open index of every run's
  // workspace + first lesson so the operator can review each side by side.
  if (keepArtifacts) {
    console.log("\n[review] artifacts kept — open these to compare:");
    for (const analysis of analyses) {
      console.log(`[review] ${analysis.runName} — folder: ${analysis.workspaceDirectory}`);
      const firstLesson = analysis.lessonDetails.find((lesson) => lesson.fileName.startsWith("0001-"));
      if (firstLesson) {
        console.log(`[review]   open lesson: ${join(analysis.workspaceDirectory, "lessons", firstLesson.fileName)}`);
      }
    }
  }

  return analyses.every((analysis) => analysis.missionPresent && analysis.hasCorrect0001Lesson);
}

let allRunsPassed = false;
try {
  allRunsPassed = await main();
} catch (error) {
  console.error(`[compare] unexpected error: ${error?.message ?? error}`);
} finally {
  cleanupArtifacts();
  console.log(
    allRunsPassed
      ? "[PASS] all four runs produced MISSION.md and a correctly named 0001 lesson"
      : "[FAIL] one or more runs missed MISSION.md or a correctly named 0001 lesson"
  );
  process.exitCode = allRunsPassed ? 0 : 1;
}
