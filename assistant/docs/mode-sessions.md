# Transcript mode sessions

Mode sessions are compact, conversation-owned lifecycle records for grouping
computer-use, browser, Live vision, and reserved Ambient transcript activity.
They connect runtime producers to immutable message membership while keeping
model input and stored message content unchanged.

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
not reconstructed after restart. Resumed mode work uses a fresh session ID and
callbacks from retired source generations are rejected.

New producer admissions are controlled by the default-off `session-groups`
assistant feature flag. Browser and computer-use actions still execute when the
flag is off, but they do not activate or claim a mode session. Existing owners
and terminal cleanup continue to drain so disabling the flag cannot strand
accepted work. Live voice snapshots the flag when its socket session is
created: disabled sessions retain the existing camera transport without
advertising or preparing tracked sight-session epochs.

The migration, startup recovery, persisted message stamps, and history reads
remain available while the flag is off. This keeps records made by an enabled
cohort compatible with rollback and later re-enablement.

## Runtime ownership

Each live `Conversation` owns one `ConversationModeSessionCoordinator`.
Computer-use, browser, and camera producers activate a source with a stable
source identity and guarded generation. The first accepted mode action claims
the logical turn. The coordinator backfills rows already persisted for that
turn, then stamps later user, assistant, and tool-result rows as they are
inserted. A turn keeps its first owner when another mode acts inside it.

Source eligibility and captured turn ownership end separately. Ending or
resetting a source prevents future claims immediately, but a captured turn
keeps its owner until its final output is persisted. Ordinary computer-use and
browser sources finish when the turn settles. Camera sources use a source
lifetime plus a synthetic run turn, so accepted frame writes and captured
voice turns form a settlement barrier before terminal persistence. A camera
epoch snapshots ownership before asynchronous frame persistence; stale epochs
cannot join a later run.

The coordinator stores only `active`, `completed`, or `interrupted`. Waiting
and finishing are revisioned runtime hints. Terminal dispositions remain
pending in memory until all captured turns release, then one idempotent
compare-and-swap update records the terminal outcome. A successful turn with
no explicit producer end also finalizes, allowing later work from the same
resource generation to mint a new session.

Regular reload, TTL, LRU, and memory-pressure eviction retain a conversation
while it has an eligible mode source, captured owner, structural association,
or unsettled terminal disposition. This preserves accepted camera output and
exact structural continuation in the coordinator that admitted them. A long
structural wait therefore remains resident until it is consumed, invalidated,
or its source retires. Explicit conversation deletion and process shutdown
keep their existing teardown semantics; startup recovery interrupts any
durable active record left by process exit.

## Structural continuation

When an owned computer-use or browser turn ends on an existing question,
confirmation, secret request, or blocking UI surface, the coordinator records
that exact response identifier in memory and leaves the session active. Only
the accepted response carrying the same kind and identifier can claim the
continuation turn. Rejected, stale, unrelated, or cross-conversation responses
cannot inherit ownership. Accepting or dismissing a surface consumes or
invalidates its association. Ordinary prose and an idle reusable resource do
not continue a session.

Structural associations intentionally do not survive restart. Startup recovery
terminalizes the old record, and a late response remains part of the existing
interaction flow without reopening that record.

## Transcript and synchronization

`modeSession` is optional message metadata and is stripped from caller-supplied
metadata. Membership is added only after a row insert succeeds. Text and
thinking deltas carry no repeated ownership field; row-boundary events carry
the current owner, and the normal conversation-messages invalidation refetches
retrospective stamps.

History returns one batched `modeSessions` descriptor list beside messages.
The query resolves records for page members and accepts bounded explicit IDs
for groups already loaded outside the newest page. Consolidation never crosses
a stamped/unstamped or different-owner boundary. Same-owner folds retain row
aliases and `modeSessionActivity.firstAt`/`lastAt`, so donor timestamps survive
history compaction.

Message deletion and retry paths recompute replaceable first/last display
boundaries for every affected conversation session. They preserve status,
terminal time, reason, and confirmed activity, and increment the revision.
Deleting every owned row leaves the lifecycle record available for audit but
produces no transcript container.

All membership, lifecycle, boundary, and runtime-hint changes reuse the
conversation-messages `sync_changed` tag. Clients merge descriptors by
revision and refetch through the existing history reconciliation path. There
is no separate session event stream or polling endpoint.
