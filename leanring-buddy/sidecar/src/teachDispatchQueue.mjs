// Durable teach-dispatch queue.
//
// Teach work is intentionally fire-and-forget, which means a sidecar process
// can exit while a lesson is still building. Persisting dispatch inputs lets
// the next sidecar instance retry that work without making normal chat turns
// wait for it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationSupportDirectory } from "./appSupport.mjs";
import { emitLog } from "./protocol.mjs";

function pendingDispatchesFilePath() {
  return join(applicationSupportDirectory(), "pending-teach-dispatches.json");
}

function emitQueueWarning(message) {
  // Logging must not let an unavailable stdout pipe turn best-effort
  // persistence into a dispatch failure.
  try {
    emitLog("warn", message);
  } catch {
    // No further recovery is possible when the sidecar's protocol output is unavailable.
  }
}

function readPendingDispatches() {
  const queueFilePath = pendingDispatchesFilePath();
  let queueFileContents;
  try {
    queueFileContents = readFileSync(queueFilePath, "utf8");
  } catch (readError) {
    if (readError?.code !== "ENOENT") {
      emitQueueWarning(
        `could not read pending teach dispatch queue: ${String(readError?.message ?? readError)}`
      );
    }
    return [];
  }

  try {
    const pendingDispatches = JSON.parse(queueFileContents);
    if (!Array.isArray(pendingDispatches)) {
      emitQueueWarning("pending teach dispatch queue was not a JSON array; treating it as empty");
      return [];
    }
    return pendingDispatches;
  } catch (parseError) {
    emitQueueWarning(
      `could not parse pending teach dispatch queue: ${String(parseError?.message ?? parseError)}`
    );
    return [];
  }
}

function writePendingDispatches(pendingDispatches) {
  const queueFilePath = pendingDispatchesFilePath();
  try {
    mkdirSync(applicationSupportDirectory(), { recursive: true });
    writeFileSync(queueFilePath, JSON.stringify(pendingDispatches, null, 2) + "\n");
    return true;
  } catch (writeError) {
    emitQueueWarning(
      `could not write pending teach dispatch queue: ${String(writeError?.message ?? writeError)}`
    );
    return false;
  }
}

/** Records a dispatch before lesson setup starts, replacing an earlier entry with the same id. */
export function recordPendingDispatch(pendingDispatchEntry) {
  const existingPendingDispatches = readPendingDispatches();
  const pendingDispatchesWithoutMatchingId = existingPendingDispatches.filter(
    (existingPendingDispatch) => existingPendingDispatch?.id !== pendingDispatchEntry.id
  );
  writePendingDispatches([...pendingDispatchesWithoutMatchingId, pendingDispatchEntry]);
}

/** Removes a completed or failed dispatch. Missing entries intentionally do nothing. */
export function clearPendingDispatch(dispatchId) {
  const existingPendingDispatches = readPendingDispatches();
  const remainingPendingDispatches = existingPendingDispatches.filter(
    (existingPendingDispatch) => existingPendingDispatch?.id !== dispatchId
  );
  if (remainingPendingDispatches.length === existingPendingDispatches.length) {
    return;
  }
  writePendingDispatches(remainingPendingDispatches);
}

/**
 * Atomically-in-intent hands pending work to startup recovery. Empty the
 * durable queue before dispatching so an immediate second process restart
 * cannot duplicate entries that this process already owns.
 */
export function takePendingDispatches(maximumAgeMilliseconds) {
  const existingPendingDispatches = readPendingDispatches();
  writePendingDispatches([]);

  const currentTimeMilliseconds = Date.now();
  const earliestAcceptedCreatedAt = currentTimeMilliseconds - maximumAgeMilliseconds;
  const pendingDispatches = [];
  let droppedStaleCount = 0;

  for (const pendingDispatch of existingPendingDispatches) {
    if (pendingDispatch?.createdAt >= earliestAcceptedCreatedAt) {
      pendingDispatches.push(pendingDispatch);
    } else {
      droppedStaleCount += 1;
    }
  }

  return { pendingDispatches, droppedStaleCount };
}
