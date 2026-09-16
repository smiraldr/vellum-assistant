import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";

export const SESSION_GROUPS_FLAG_KEY = "session-groups";

/** Whether this assistant may admit new transcript mode-session tracking. */
export function isSessionGroupsEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(SESSION_GROUPS_FLAG_KEY);
}
