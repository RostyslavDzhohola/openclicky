export function chatModelForBackend(selectedBackend) {
  return selectedBackend === "claude" ? "claude-sonnet-4-6" : "default";
}
