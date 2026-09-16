import { z } from "zod";

export const ModeSessionModeSchema = z.enum([
  "computer_use",
  "browser",
  "live_vision",
  "ambient",
]);
export type ModeSessionMode = z.infer<typeof ModeSessionModeSchema>;

export const ModeSessionStatusSchema = z.enum([
  "active",
  "completed",
  "interrupted",
]);
export type ModeSessionStatus = z.infer<typeof ModeSessionStatusSchema>;

/** Immutable ownership stamped onto transcript message metadata. */
export const ModeSessionSchema = z.object({
  mode: ModeSessionModeSchema,
  id: z.string().min(1),
});
export type ModeSession = z.infer<typeof ModeSessionSchema>;

const ModeSessionSummaryBaseSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  mode: ModeSessionModeSchema,
  sourceStartedAt: z.number().int().nonnegative(),
  firstIncludedAt: z.number().int().nonnegative().nullable(),
  firstIncludedMessageId: z.string().min(1).nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  lastOwnedMessageId: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
});

/** Durable lifecycle summary for one conversation-owned presentation run. */
export const ModeSessionSummarySchema = z
  .discriminatedUnion("status", [
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("active"),
      endedAt: z.null(),
      endReason: z.null(),
    }),
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("completed"),
      endedAt: z.number().int().nonnegative(),
      endReason: z.string().min(1),
    }),
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("interrupted"),
      endedAt: z.number().int().nonnegative().nullable(),
      endReason: z.string().min(1),
    }),
  ])
  .superRefine((summary, ctx) => {
    if (
      (summary.firstIncludedAt === null) !==
      (summary.firstIncludedMessageId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "First included time and message ID must be set together",
      });
    }
    if (summary.endedAt !== null && summary.endedAt < summary.lastActivityAt) {
      ctx.addIssue({
        code: "custom",
        message: "Mode session end cannot precede its last activity",
        path: ["endedAt"],
      });
    }
    if (summary.lastActivityAt < summary.sourceStartedAt) {
      ctx.addIssue({
        code: "custom",
        message: "Last activity cannot precede source start",
        path: ["lastActivityAt"],
      });
    }
    if (
      summary.firstIncludedAt !== null &&
      summary.firstIncludedAt > summary.lastActivityAt
    ) {
      ctx.addIssue({
        code: "custom",
        message: "First included time cannot follow last activity",
        path: ["firstIncludedAt"],
      });
    }
  });
export type ModeSessionSummary = z.infer<typeof ModeSessionSummarySchema>;
