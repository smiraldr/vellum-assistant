import { recoverActiveConversationModeSessions } from "../persistence/conversation-mode-sessions.js";
import {
  type DbMigrationFailureDetails,
  setDbMigrationFailed,
  setDbReady,
} from "./daemon-readiness.js";

export type ModeSessionStartupRecoveryResult =
  | { ok: true; interruptedCount: number }
  | { ok: false; error: unknown };

/**
 * Recovers abandoned mode sessions before publishing database readiness.
 * A failed recovery keeps database-backed work gated for this boot.
 */
export function recoverModeSessionsBeforeDbReady(
  migrationDetails: DbMigrationFailureDetails,
  recover: () => number = recoverActiveConversationModeSessions,
): ModeSessionStartupRecoveryResult {
  try {
    const interruptedCount = recover();
    setDbReady(true);
    return { ok: true, interruptedCount };
  } catch (error) {
    setDbMigrationFailed(error, migrationDetails);
    return { ok: false, error };
  }
}
