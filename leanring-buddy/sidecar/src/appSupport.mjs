// Application Support directory resolution.
//
// Sidecar modules keep durable app-managed state under the same directory.
// Resolve the environment override each time so terminal tests can isolate
// individual operations without requiring a fresh module import.

import { homedir } from "node:os";
import { join } from "node:path";

export function applicationSupportDirectory() {
  return (
    process.env.CLICKY_APP_SUPPORT ??
    join(homedir(), "Library", "Application Support", "OpenClicky")
  );
}
