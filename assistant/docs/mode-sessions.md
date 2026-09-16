# Transcript mode sessions

Mode sessions are compact, conversation-owned lifecycle records for grouping
future computer-use, browser, Live vision, and Ambient transcript activity.
This foundation stores timing and terminal truth. It does not activate a
producer, stamp messages, alter model input, or change transcript rendering.

## API contract

`src/api/mode-session.ts` owns both shared shapes:

- `ModeSession` is immutable transcript membership: an opaque `id` and one of
  `computer_use`, `browser`, `live_vision`, or `ambient`.
- `ModeSessionSummary` is the durable lifecycle record. It carries the owning
  conversation, mode, timing bounds, boundary message IDs, terminal reason,
  and a positive monotonic revision.

Only three statuses are stored: `active`, `completed`, and `interrupted`.
Waiting and draining are runtime presentation facts and do not add database
states. Duration is derived from recorded time bounds instead of stored as a
separate value. Active records have no terminal fields, completed records have
a confirmed end, and interrupted records may leave the end unknown. A known end
never precedes the last confirmed activity.

## Persistence

Migration 379 creates `conversation_mode_sessions`. Each row belongs to one
conversation through an `ON DELETE CASCADE` foreign key. The
`(conversation_id, status)` index supports conversation-scoped active reads,
while the primary key supports bounded ID batches for transcript pages.

`conversation-mode-sessions.ts` is the only lifecycle writer. Begin creates
revision 1. Activity, boundary, revision-only, and terminal updates require the
caller's expected revision and run in an immediate transaction. Each accepted
write increments the revision. A stale revision, missing record, or terminal
record is returned as an expected write outcome. Terminal rows cannot return
to active or change to a different terminal result. Repeating the same terminal
outcome is an accepted no-op and does not advance the revision.

The first included boundary can precede source activation when a later action
claims assistant content already persisted in the same logical turn. Last
activity never moves backward. An interruption may have an unknown end, so
`endedAt` remains nullable and `lastActivityAt` remains the last confirmed
time.

## Startup recovery

After database migrations succeed, the assistant marks every leftover active
record interrupted before database readiness is published. Recovery increments
the revision, preserves activity and message boundaries, records
`assistant_restarted`, and leaves `endedAt` null. It runs on every boot rather
than as a checkpointed migration.

If recovery fails, database readiness remains failed and the assistant keeps
its diagnostic surfaces available in degraded startup. New database-backed
turns and interrupted-turn auto-resume do not start against records that still
look active.

Runtime source generations and structural question associations are owned by
the producer and message-membership integration. Those process-local facts are
not reconstructed by this storage layer. Later integration must use a fresh
session ID for mode work that resumes after restart and must reject callbacks
from retired source generations.
