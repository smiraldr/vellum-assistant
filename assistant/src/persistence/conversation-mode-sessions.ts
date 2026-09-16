import { and, eq, inArray, sql } from "drizzle-orm";

import {
  type ModeSessionMode,
  type ModeSessionStatus,
  type ModeSessionSummary,
  ModeSessionSummarySchema,
} from "../api/mode-session.js";
import { type DrizzleDb, getDb } from "./db-connection.js";
import { conversationModeSessions } from "./schema/index.js";

export type ModeSessionWriteFailureReason =
  | "already_exists"
  | "not_found"
  | "stale_revision"
  | "terminal";

export type ModeSessionWriteResult =
  | { ok: true; session: ModeSessionSummary }
  | {
      ok: false;
      reason: ModeSessionWriteFailureReason;
      session?: ModeSessionSummary;
    };

export interface ModeSessionStoreOptions {
  db?: DrizzleDb;
}

type ModeSessionReader = Pick<DrizzleDb, "select">;

interface ModeSessionMutationOptions extends ModeSessionStoreOptions {
  acceptTerminal?: (
    current: typeof conversationModeSessions.$inferSelect,
  ) => boolean;
}

export interface BeginModeSessionInput {
  id: string;
  conversationId: string;
  mode: ModeSessionMode;
  sourceStartedAt: number;
}

export interface RevisionedModeSessionInput {
  id: string;
  conversationId: string;
  expectedRevision: number;
}

export interface UpdateModeSessionActivityInput extends RevisionedModeSessionInput {
  lastActivityAt: number;
  lastOwnedMessageId?: string | null;
}

export interface UpdateModeSessionBoundariesInput extends RevisionedModeSessionInput {
  firstIncluded: { at: number; messageId: string } | null;
  lastOwnedMessageId: string | null;
}

interface FinalizeModeSessionInputBase extends RevisionedModeSessionInput {
  endReason: string;
  lastActivityAt?: number;
  lastOwnedMessageId?: string | null;
}

export type FinalizeModeSessionInput = FinalizeModeSessionInputBase &
  (
    | { status: Extract<ModeSessionStatus, "completed">; endedAt: number }
    | {
        status: Extract<ModeSessionStatus, "interrupted">;
        endedAt: number | null;
      }
  );

function toSummary(
  row: typeof conversationModeSessions.$inferSelect,
): ModeSessionSummary {
  return ModeSessionSummarySchema.parse(row);
}

function getSession(
  database: ModeSessionReader,
  conversationId: string,
  id: string,
): typeof conversationModeSessions.$inferSelect | undefined {
  return database
    .select()
    .from(conversationModeSessions)
    .where(
      and(
        eq(conversationModeSessions.conversationId, conversationId),
        eq(conversationModeSessions.id, id),
      ),
    )
    .get();
}

function classifyRejectedWrite(
  current: typeof conversationModeSessions.$inferSelect | undefined,
  expectedRevision: number,
): ModeSessionWriteResult {
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  const session = toSummary(current);
  if (current.status !== "active") {
    return { ok: false, reason: "terminal", session };
  }
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: "stale_revision", session };
  }
  throw new Error("Mode session write was rejected without a state conflict");
}

function mutateActiveSession(
  input: RevisionedModeSessionInput,
  buildValues: (
    current: typeof conversationModeSessions.$inferSelect,
  ) => Partial<typeof conversationModeSessions.$inferInsert>,
  options?: ModeSessionMutationOptions,
): ModeSessionWriteResult {
  const database = options?.db ?? getDb();
  return database.transaction(
    (tx) => {
      const current = getSession(tx, input.conversationId, input.id);
      if (
        !current ||
        current.status !== "active" ||
        current.revision !== input.expectedRevision
      ) {
        if (
          current &&
          current.status !== "active" &&
          options?.acceptTerminal?.(current)
        ) {
          return { ok: true, session: toSummary(current) };
        }
        return classifyRejectedWrite(current, input.expectedRevision);
      }

      tx.update(conversationModeSessions)
        .set({
          ...buildValues(current),
          revision: sql`${conversationModeSessions.revision} + 1`,
        })
        .where(
          and(
            eq(conversationModeSessions.conversationId, input.conversationId),
            eq(conversationModeSessions.id, input.id),
            eq(conversationModeSessions.status, "active"),
            eq(conversationModeSessions.revision, input.expectedRevision),
          ),
        )
        .run();

      const updated = getSession(tx, input.conversationId, input.id);
      if (!updated || updated.revision !== input.expectedRevision + 1) {
        return classifyRejectedWrite(updated, input.expectedRevision);
      }
      return { ok: true, session: toSummary(updated) };
    },
    { behavior: "immediate" },
  );
}

export function beginConversationModeSession(
  input: BeginModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  const database = options?.db ?? getDb();
  return database.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(conversationModeSessions)
        .where(eq(conversationModeSessions.id, input.id))
        .get();
      if (existing) {
        return {
          ok: false,
          reason: "already_exists",
          ...(existing.conversationId === input.conversationId
            ? { session: toSummary(existing) }
            : {}),
        };
      }

      tx.insert(conversationModeSessions)
        .values({
          ...input,
          status: "active",
          firstIncludedAt: null,
          firstIncludedMessageId: null,
          lastActivityAt: input.sourceStartedAt,
          lastOwnedMessageId: null,
          endedAt: null,
          endReason: null,
          revision: 1,
        })
        .run();
      const created = getSession(tx, input.conversationId, input.id);
      if (!created) {
        throw new Error("Mode session insert did not create a readable row");
      }
      return { ok: true, session: toSummary(created) };
    },
    { behavior: "immediate" },
  );
}

export function updateConversationModeSessionActivity(
  input: UpdateModeSessionActivityInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    (current) => ({
      lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
      ...(input.lastOwnedMessageId !== undefined
        ? { lastOwnedMessageId: input.lastOwnedMessageId }
        : {}),
    }),
    options,
  );
}

export function updateConversationModeSessionBoundaries(
  input: UpdateModeSessionBoundariesInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    () => ({
      firstIncludedAt: input.firstIncluded?.at ?? null,
      firstIncludedMessageId: input.firstIncluded?.messageId ?? null,
      lastOwnedMessageId: input.lastOwnedMessageId,
    }),
    options,
  );
}

export function advanceConversationModeSessionRevision(
  input: RevisionedModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(input, () => ({}), options);
}

export function finalizeConversationModeSession(
  input: FinalizeModeSessionInput,
  options?: ModeSessionStoreOptions,
): ModeSessionWriteResult {
  return mutateActiveSession(
    input,
    (current) => {
      const lastActivityAt = Math.max(
        current.lastActivityAt,
        input.lastActivityAt ?? current.lastActivityAt,
      );
      if (input.endedAt !== null && input.endedAt < lastActivityAt) {
        throw new Error("Mode session end cannot precede its last activity");
      }
      return {
        status: input.status,
        endedAt: input.endedAt,
        endReason: input.endReason,
        lastActivityAt,
        ...(input.lastOwnedMessageId !== undefined
          ? { lastOwnedMessageId: input.lastOwnedMessageId }
          : {}),
      };
    },
    {
      ...options,
      acceptTerminal: (current) =>
        current.status === input.status &&
        current.endedAt === input.endedAt &&
        current.endReason === input.endReason &&
        (input.lastActivityAt === undefined ||
          input.lastActivityAt <= current.lastActivityAt) &&
        (input.lastOwnedMessageId === undefined ||
          input.lastOwnedMessageId === current.lastOwnedMessageId),
    },
  );
}

export function getConversationModeSession(
  conversationId: string,
  id: string,
  options?: ModeSessionStoreOptions,
): ModeSessionSummary | null {
  const row = getSession(options?.db ?? getDb(), conversationId, id);
  return row ? toSummary(row) : null;
}

export function listConversationModeSessionsByIds(
  conversationId: string,
  ids: readonly string[],
  options?: ModeSessionStoreOptions,
): ModeSessionSummary[] {
  if (ids.length === 0) {
    return [];
  }
  const rows = (options?.db ?? getDb())
    .select()
    .from(conversationModeSessions)
    .where(
      and(
        eq(conversationModeSessions.conversationId, conversationId),
        inArray(conversationModeSessions.id, [...new Set(ids)]),
      ),
    )
    .all();
  return rows.map(toSummary);
}

export function recoverActiveConversationModeSessions(
  options?: ModeSessionStoreOptions,
): number {
  const result = (options?.db ?? getDb())
    .update(conversationModeSessions)
    .set({
      status: "interrupted",
      endedAt: null,
      endReason: "assistant_restarted",
      revision: sql`${conversationModeSessions.revision} + 1`,
    })
    .where(eq(conversationModeSessions.status, "active"))
    .run() as unknown as { changes: number };
  return result.changes;
}
