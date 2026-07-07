// NDJSON protocol helpers. Every message between the Swift app and this
// sidecar is a single JSON object on its own line, written to stdout
// (events) or read from stdin (requests).

/**
 * Writes one event object to stdout as a single NDJSON line.
 * This is the ONLY place that writes protocol output — everything else in
 * the sidecar must log to stderr so stdout stays machine-parseable.
 */
export function emitEvent(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** Emits a log event (also mirrored to stderr for Xcode console visibility). */
export function emitLog(level, message) {
  process.stderr.write(`[sidecar:${level}] ${message}\n`);
  emitEvent({ type: "log", level, message });
}

/** Emits an error event correlated to a request id. */
export function emitError(requestId, code, message, backend) {
  const errorEvent = { id: requestId, type: "error", code, message };
  if (backend) {
    errorEvent.backend = backend;
  }
  emitEvent(errorEvent);
}

/**
 * Parses one stdin line into a request object.
 * Returns null (and logs) on malformed input instead of throwing, so one
 * bad line can never take the protocol loop down.
 */
export function parseRequestLine(line) {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return null;
  }
  try {
    const request = JSON.parse(trimmedLine);
    if (typeof request !== "object" || request === null) {
      emitLog("warn", `Ignoring non-object request line: ${trimmedLine.slice(0, 200)}`);
      return null;
    }
    if (typeof request.type !== "string") {
      emitLog("warn", `Ignoring request without a type: ${trimmedLine.slice(0, 200)}`);
      return null;
    }
    return request;
  } catch (parseError) {
    emitLog("warn", `Ignoring unparseable request line: ${trimmedLine.slice(0, 200)}`);
    return null;
  }
}
