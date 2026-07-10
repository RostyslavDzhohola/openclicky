import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { applicationSupportDirectory } from "./appSupport.mjs";

const DEFAULT_MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETAINED_FILE_COUNT = 5;
const TRACE_FILE_NAME = "agent-trace.jsonl";
const SENSITIVE_FIELD_NAMES = /^(api[-_]?key|authorization|base64|image|images|screenshot|screenshots|systemPrompt|token)$/i;

function sanitizedTraceValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\b(api[-_]?key|authorization|token)\s*[:=]\s*[^\s"']+/gi, "$1=[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizedTraceValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([fieldName]) => !SENSITIVE_FIELD_NAMES.test(fieldName))
        .map(([fieldName, fieldValue]) => [fieldName, sanitizedTraceValue(fieldValue)])
    );
  }
  return value;
}

function compactTraceDescription(traceEvent) {
  const identifiers = [
    traceEvent.turnId ? `turn=${traceEvent.turnId}` : null,
    traceEvent.dispatchId ? `dispatch=${traceEvent.dispatchId}` : null,
    traceEvent.interviewId ? `interview=${traceEvent.interviewId}` : null,
    traceEvent.agentRole ? `role=${traceEvent.agentRole}` : null,
    traceEvent.workspaceId ? `workspace=${traceEvent.workspaceId}` : null,
  ].filter(Boolean);
  const diagnosticValue =
    traceEvent.route ??
    traceEvent.tool ??
    traceEvent.message ??
    traceEvent.text ??
    traceEvent.transcript ??
    traceEvent.detail;
  const diagnosticSuffix = diagnosticValue
    ? ` detail="${String(diagnosticValue).replace(/\r?\n/g, " ").slice(0, 240)}"`
    : "";
  return `[agent-trace] ${traceEvent.event}${identifiers.length ? ` ${identifiers.join(" ")}` : ""}${diagnosticSuffix}`;
}

export function createAgentTraceWriter({
  enabled,
  traceDirectory = join(applicationSupportDirectory(), "logs"),
  maximumFileBytes = DEFAULT_MAXIMUM_FILE_BYTES,
  retainedFileCount = DEFAULT_RETAINED_FILE_COUNT,
  mirrorLine = (line) => process.stderr.write(line + "\n"),
} = {}) {
  const traceFilePath = join(traceDirectory, TRACE_FILE_NAME);

  function rotateIfNeeded(nextLineByteCount) {
    const currentFileByteCount = existsSync(traceFilePath) ? statSync(traceFilePath).size : 0;
    if (currentFileByteCount + nextLineByteCount <= maximumFileBytes) return;

    const oldestRotatedFilePath = `${traceFilePath}.${retainedFileCount - 1}`;
    rmSync(oldestRotatedFilePath, { force: true });
    for (let rotationIndex = retainedFileCount - 2; rotationIndex >= 1; rotationIndex -= 1) {
      const existingRotatedFilePath = `${traceFilePath}.${rotationIndex}`;
      if (existsSync(existingRotatedFilePath)) {
        renameSync(existingRotatedFilePath, `${traceFilePath}.${rotationIndex + 1}`);
      }
    }
    if (existsSync(traceFilePath)) {
      renameSync(traceFilePath, `${traceFilePath}.1`);
    }
  }

  function trace(event, fields = {}) {
    if (!enabled) return;
    try {
      const traceEvent = sanitizedTraceValue({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        event,
        ...fields,
      });
      const serializedLine = JSON.stringify(traceEvent) + "\n";
      mkdirSync(traceDirectory, { recursive: true });
      rotateIfNeeded(Buffer.byteLength(serializedLine));
      appendFileSync(traceFilePath, serializedLine);
      mirrorLine(compactTraceDescription(traceEvent));
    } catch {
      // Tracing is diagnostic-only and must never affect a companion turn.
    }
  }

  return { trace };
}

const sharedAgentTraceWriter = createAgentTraceWriter({
  enabled: process.env.CLICKY_AGENT_TRACE === "1",
});

export function traceAgentEvent(event, fields = {}) {
  sharedAgentTraceWriter.trace(event, fields);
}
