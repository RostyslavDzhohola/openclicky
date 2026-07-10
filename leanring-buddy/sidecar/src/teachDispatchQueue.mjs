// Durable teach-dispatch queue.
//
// Teach work is intentionally fire-and-forget, which means a sidecar process
// can exit while a lesson is still building. Persisting dispatch inputs lets
// the next sidecar instance retry that work without making normal chat turns
// wait for it.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  const temporaryQueueFilePath = `${queueFilePath}.${process.pid}.tmp`;
  try {
    mkdirSync(applicationSupportDirectory(), { recursive: true });
    // Replacing the queue only after its complete contents exist in a sibling
    // file prevents a process kill from corrupting the last durable queue.
    writeFileSync(temporaryQueueFilePath, JSON.stringify(pendingDispatches, null, 2) + "\n");
    renameSync(temporaryQueueFilePath, queueFilePath);
    return true;
  } catch (writeError) {
    // A failed write or rename can leave the sibling file behind. Its cleanup
    // is best-effort for the same reason queue persistence itself is best-effort.
    try {
      unlinkSync(temporaryQueueFilePath);
    } catch {
      // The temporary file may not have been created, or it may have been renamed already.
    }
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
 * Loads fresh work for startup recovery while retaining it durably until the
 * re-dispatched work settles and clears its own entry. A crash at any point
 * during recovery therefore leaves entries on disk for the next startup;
 * only a settled dispatch clears its entry. Stale entries are durably dropped.
 */
export function loadPendingDispatchesForRecovery(maximumAgeMilliseconds) {
  const existingPendingDispatches = readPendingDispatches();

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

  writePendingDispatches(pendingDispatches);
  return { pendingDispatches, droppedStaleCount };
}
