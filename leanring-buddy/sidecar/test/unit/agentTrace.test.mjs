import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentTraceWriter } from "../../src/agentTrace.mjs";

test("trace writer persists a versioned correlated event without sensitive payloads", () => {
  const traceDirectory = mkdtempSync(join(tmpdir(), "clicky-agent-trace-"));
  const mirroredLines = [];
  const traceWriter = createAgentTraceWriter({
    enabled: true,
    traceDirectory,
    mirrorLine: (line) => mirroredLines.push(line),
  });

  traceWriter.trace("turn.received", {
    traceId: "trace-1",
    turnId: "turn-1",
    agentRole: "chat",
    transcript: "teach me CSS",
    imageCount: 1,
    images: [{ path: "/secret/screen.png", base64: "secret" }],
    apiKey: "secret-key",
    detail: "curl -H 'Authorization: Bearer secret-token' https://example.com?token=secret-value",
  });

  const persistedEvent = JSON.parse(
    readFileSync(join(traceDirectory, "agent-trace.jsonl"), "utf8").trim()
  );
  assert.equal(persistedEvent.schemaVersion, 1);
  assert.equal(persistedEvent.event, "turn.received");
  assert.equal(persistedEvent.traceId, "trace-1");
  assert.equal(persistedEvent.turnId, "turn-1");
  assert.equal(persistedEvent.transcript, "teach me CSS");
  assert.equal(persistedEvent.imageCount, 1);
  assert.equal("images" in persistedEvent, false);
  assert.equal("apiKey" in persistedEvent, false);
  assert.doesNotMatch(persistedEvent.detail, /secret-token|secret-value/);
  assert.match(mirroredLines[0], /turn\.received/);
  assert.match(mirroredLines[0], /teach me CSS/);
});

test("disabled trace writer performs no writes or console mirroring", () => {
  const traceDirectory = mkdtempSync(join(tmpdir(), "clicky-agent-trace-disabled-"));
  const mirroredLines = [];
  const traceWriter = createAgentTraceWriter({
    enabled: false,
    traceDirectory,
    mirrorLine: (line) => mirroredLines.push(line),
  });

  traceWriter.trace("agent.started", { turnId: "turn-1" });

  assert.deepEqual(readdirSync(traceDirectory), []);
  assert.deepEqual(mirroredLines, []);
});

test("trace writer rotates bounded files before exceeding its configured size", () => {
  const traceDirectory = mkdtempSync(join(tmpdir(), "clicky-agent-trace-rotation-"));
  const traceWriter = createAgentTraceWriter({
    enabled: true,
    traceDirectory,
    maximumFileBytes: 220,
    retainedFileCount: 3,
    mirrorLine: () => {},
  });

  for (let eventIndex = 0; eventIndex < 12; eventIndex += 1) {
    traceWriter.trace("agent.tool", {
      turnId: `turn-${eventIndex}`,
      detail: "x".repeat(80),
    });
  }

  const traceFiles = readdirSync(traceDirectory).filter((fileName) =>
    fileName.startsWith("agent-trace")
  );
  assert.ok(traceFiles.length > 1);
  assert.ok(traceFiles.length <= 3);
});

test("trace writer never throws when persistence or mirroring fails", () => {
  const traceWriter = createAgentTraceWriter({
    enabled: true,
    traceDirectory: "/dev/null/not-a-directory",
    mirrorLine: () => {
      throw new Error("console unavailable");
    },
  });

  assert.doesNotThrow(() => {
    traceWriter.trace("agent.failed", { turnId: "turn-1", message: "failure" });
  });
});

test("one trace id reconstructs chat routing and its background Teach lifecycle", () => {
  const traceDirectory = mkdtempSync(join(tmpdir(), "clicky-agent-trace-flow-"));
  const traceWriter = createAgentTraceWriter({
    enabled: true,
    traceDirectory,
    mirrorLine: () => {},
  });
  const correlation = { traceId: "trace-1", parentTurnId: "turn-1" };

  traceWriter.trace("turn.received", {
    ...correlation,
    turnId: "turn-1",
    agentRole: "chat",
  });
  traceWriter.trace("routing.parsed", {
    ...correlation,
    turnId: "turn-1",
    agentRole: "chat",
    route: "teach",
  });
  traceWriter.trace("teach.queued", {
    ...correlation,
    dispatchId: "dispatch-1",
    agentRole: "topic-builder",
  });
  traceWriter.trace("lesson.emitted", {
    ...correlation,
    dispatchId: "dispatch-1",
    agentRole: "topic-builder",
  });
  traceWriter.trace("response.emitted", {
    ...correlation,
    dispatchId: "dispatch-1",
    agentRole: "topic-builder",
  });

  const persistedEvents = readFileSync(join(traceDirectory, "agent-trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((serializedEvent) => JSON.parse(serializedEvent));
  assert.deepEqual(
    persistedEvents.map((persistedEvent) => persistedEvent.event),
    [
      "turn.received",
      "routing.parsed",
      "teach.queued",
      "lesson.emitted",
      "response.emitted",
    ]
  );
  assert.equal(persistedEvents.every((persistedEvent) => persistedEvent.traceId === "trace-1"), true);
  assert.equal(
    persistedEvents.slice(2).every((persistedEvent) => persistedEvent.dispatchId === "dispatch-1"),
    true
  );
});
