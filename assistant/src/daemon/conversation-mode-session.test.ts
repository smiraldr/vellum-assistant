import { describe, expect, test } from "bun:test";

import type { ModeSessionSummary } from "../api/mode-session.js";
import type { ModeSessionWriteResult } from "../persistence/conversation-mode-sessions.js";
import {
  ConversationModeSessionCoordinator,
  type ConversationModeSessionCoordinatorDependencies,
} from "./conversation-mode-session.js";

function activeSession(
  overrides: Partial<ModeSessionSummary> = {},
): ModeSessionSummary {
  return {
    id: "session-123",
    conversationId: "conv-123",
    mode: "computer_use",
    status: "active",
    sourceStartedAt: 100,
    firstIncludedAt: null,
    firstIncludedMessageId: null,
    lastActivityAt: 100,
    lastOwnedMessageId: null,
    endedAt: null,
    endReason: null,
    revision: 1,
    ...overrides,
  } as ModeSessionSummary;
}

function createDependencies(initial = activeSession()) {
  let session: ModeSessionSummary = initial;
  const stamps: Array<{ messageId: string; sessionId: string }> = [];
  let publications = 0;
  let forceStaleOnce = false;
  const stampFailures = new Set<string>();

  const staleOrMutate = (
    expectedRevision: number,
    mutate: (current: ModeSessionSummary) => ModeSessionSummary,
  ): ModeSessionWriteResult => {
    if (forceStaleOnce) {
      forceStaleOnce = false;
      session = { ...session, revision: session.revision + 1 };
      return { ok: false, reason: "stale_revision", session };
    }
    if (session.status !== "active") {
      return { ok: false, reason: "terminal", session };
    }
    if (session.revision !== expectedRevision) {
      return { ok: false, reason: "stale_revision", session };
    }
    session = mutate(session);
    return { ok: true, session };
  };

  const dependencies: ConversationModeSessionCoordinatorDependencies = {
    createId: () => "session-created",
    beginSession: (input) => {
      session = activeSession({
        id: input.id,
        conversationId: input.conversationId,
        mode: input.mode,
        sourceStartedAt: input.sourceStartedAt,
        lastActivityAt: input.sourceStartedAt,
      });
      return { ok: true, session };
    },
    getSession: (conversationId, id) =>
      conversationId === session.conversationId && id === session.id
        ? session
        : null,
    updateActivity: (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
        lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
        ...(input.lastOwnedMessageId !== undefined
          ? { lastOwnedMessageId: input.lastOwnedMessageId }
          : {}),
      })),
    updateBoundaries: (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
        firstIncludedAt: input.firstIncluded?.at ?? null,
        firstIncludedMessageId: input.firstIncluded?.messageId ?? null,
        lastOwnedMessageId: input.lastOwnedMessageId,
      })),
    advanceRevision: (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
      })),
    finalize: (input) =>
      staleOrMutate(
        input.expectedRevision,
        (current) =>
          ({
            ...current,
            revision: current.revision + 1,
            status: input.status,
            endedAt: input.endedAt,
            endReason: input.endReason,
            lastActivityAt: Math.max(
              current.lastActivityAt,
              input.lastActivityAt ?? current.lastActivityAt,
            ),
            ...(input.lastOwnedMessageId !== undefined
              ? { lastOwnedMessageId: input.lastOwnedMessageId }
              : {}),
          }) as ModeSessionSummary,
      ),
    stampMessage: (messageId, owner) => {
      if (stampFailures.has(messageId)) {
        throw new Error("metadata write failed");
      }
      stamps.push({ messageId, sessionId: owner.id });
    },
    publishMessagesChanged: () => {
      publications += 1;
    },
  };

  return {
    dependencies,
    stamps,
    session: () => session,
    publications: () => publications,
    forceStale: () => {
      forceStaleOnce = true;
    },
    replaceSession: (next: ModeSessionSummary) => {
      session = next;
    },
    failStamp: (messageId: string) => {
      stampFailures.add(messageId);
    },
    allowStamp: (messageId: string) => {
      stampFailures.delete(messageId);
    },
  };
}

function registerSource(
  coordinator: ConversationModeSessionCoordinator,
  session: ModeSessionSummary,
  sourceId = "computer-source",
  generation = 1,
) {
  const handle = coordinator.registerSource({
    sourceId,
    generation,
    session,
  });
  expect(handle).toBeDefined();
  return handle!;
}

describe("ConversationModeSessionCoordinator", () => {
  test("does not retain unowned or terminal bookkeeping", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );

    expect(coordinator.hasResidentWork()).toBe(false);
    coordinator.acceptTurn("turn-unowned");
    expect(coordinator.hasResidentWork()).toBe(false);
    coordinator.describeSummary(
      activeSession({
        status: "completed",
        endedAt: 120,
        endReason: "settled",
      }),
    );
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("activates a durable source once per generation", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    expect(
      coordinator.activateSource({
        sourceId: "computer-source",
        generation: 1,
        mode: "computer_use",
        sourceStartedAt: 200,
      }),
    ).toMatchObject({
      id: "session-created",
      mode: "computer_use",
      sourceId: "computer-source",
      generation: 1,
      activation: 1,
    });
    expect(
      coordinator.activateSource({
        sourceId: "computer-source",
        generation: 1,
        mode: "computer_use",
        sourceStartedAt: 300,
      }),
    ).toMatchObject({
      id: "session-created",
      mode: "computer_use",
      activation: 1,
    });
    expect(
      coordinator.activateSource({
        sourceId: "computer-source",
        generation: 0,
        mode: "computer_use",
        sourceStartedAt: 400,
      }),
    ).toBeUndefined();
    expect(store.session()).toMatchObject({
      sourceStartedAt: 200,
      lastActivityAt: 200,
    });
  });

  test("mints a new run after a successful turn without resetting the source", () => {
    const store = createDependencies();
    const ids = ["session-first", "session-second"];
    store.dependencies.createId = () => ids.shift()!;
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const first = coordinator.activateSource({
      sourceId: "browser-source",
      generation: 1,
      mode: "browser",
      sourceStartedAt: 100,
    });
    expect(first?.id).toBe("session-first");
    coordinator.claimTurn("turn-first", first!, 110);
    coordinator.trackPersistedRow("turn-first", "assistant-first", 120);
    expect(
      coordinator.finalizeTurn({
        turnId: "turn-first",
        status: "completed",
        endedAt: 130,
        endReason: "turn_settled",
      }),
    ).toBe(true);

    expect(
      coordinator.activateSource({
        sourceId: "browser-source",
        generation: 1,
        mode: "browser",
        sourceStartedAt: 140,
      }),
    ).toMatchObject({
      id: "session-second",
      generation: 1,
      activation: 2,
    });
  });

  test("claims once and backfills only successfully tracked rows", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());

    coordinator.acceptTurn("turn-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    expect(coordinator.claimTurn("turn-123", handle, 120)).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedAt: 90,
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
      lastActivityAt: 120,
    });

    coordinator.trackPersistedRow("turn-123", "tool-result-123", 125);
    expect(store.stamps.at(-1)).toEqual({
      messageId: "tool-result-123",
      sessionId: "session-123",
    });
    expect(
      coordinator.claimTurn(
        "turn-123",
        { sourceId: "other-source", generation: 99, activation: 1 },
        130,
      ),
    ).toEqual({ id: "session-123", mode: "computer_use" });
    expect(coordinator.retireSource({ ...handle, generation: 2 })).toBe(false);
    expect(coordinator.retireSource(handle)).toBe(true);
    expect(coordinator.getTurnOwner("turn-123")?.id).toBe("session-123");
  });

  test("starts non-Live display timing at the first assistant row", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());

    coordinator.trackPersistedRow("turn-123", "user-123", 80, {
      startsDisplayBoundary: false,
    });
    coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    coordinator.claimTurn("turn-123", handle, 120);

    expect(store.stamps).toEqual([
      { messageId: "user-123", sessionId: "session-123" },
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedAt: 90,
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("allows Live display timing to include its leading row", () => {
    const liveSession = activeSession({ mode: "live_vision" });
    const store = createDependencies(liveSession);
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, liveSession, "camera-source");

    coordinator.trackPersistedRow("turn-123", "camera-123", 80, {
      startsDisplayBoundary: false,
    });
    coordinator.claimTurn("turn-123", handle, 120);

    expect(store.session()).toMatchObject({
      firstIncludedAt: 80,
      firstIncludedMessageId: "camera-123",
      lastOwnedMessageId: "camera-123",
    });
  });

  test("inherits only an exact unconsumed structural response", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    expect(coordinator.hasResidentWork()).toBe(true);
    coordinator.acceptTurn("turn-origin");
    coordinator.claimTurn("turn-origin", handle, 110);
    expect(
      coordinator.recordStructuralWait("turn-origin", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBe(true);
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );
    coordinator.releaseTurn("turn-origin");
    expect(coordinator.hasResidentWork()).toBe(true);
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );

    expect(
      coordinator.acceptTurn("turn-wrong-kind", {
        kind: "confirmation",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
    expect(
      coordinator.acceptTurn("turn-wrong-id", {
        kind: "question",
        responseId: "interaction-456",
      }),
    ).toBeUndefined();
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );
    coordinator.acceptTurn("turn-independent");
    expect(coordinator.claimTurn("turn-independent", handle, 120)).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      undefined,
    );
    coordinator.releaseTurn("turn-independent");
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );
    expect(
      coordinator.acceptTurn("turn-resumed", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toEqual({ id: "session-123", mode: "computer_use" });
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      undefined,
    );
    expect(
      coordinator.acceptTurn("turn-replayed", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();

    const otherConversation = new ConversationModeSessionCoordinator(
      "conv-456",
      store.dependencies,
    );
    expect(
      otherConversation.acceptTurn("turn-cross-conversation", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
  });

  test("invalidates structural continuation when transcript history changes", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.claimTurn("turn-origin", handle, 110);
    coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-123",
    });
    coordinator.releaseTurn("turn-origin");
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );

    expect(coordinator.invalidateAllStructuralWaits()).toBe(1);
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      undefined,
    );
    expect(
      coordinator.acceptTurn("turn-resumed", {
        kind: "surface",
        responseId: "surface-123",
      }),
    ).toBeUndefined();
    expect(coordinator.invalidateAllStructuralWaits()).toBe(0);
  });

  test("does not inherit recovered terminal state", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.acceptTurn("turn-origin");
    coordinator.claimTurn("turn-origin", handle, 110);
    coordinator.recordStructuralWait("turn-origin", {
      kind: "question",
      responseId: "interaction-123",
    });
    coordinator.releaseTurn("turn-origin");
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );
    store.replaceSession(
      activeSession({
        status: "interrupted",
        endedAt: null,
        endReason: "assistant_restarted",
        revision: 4,
      }),
    );

    expect(
      coordinator.acceptTurn("turn-after-restart", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
    expect(coordinator.descriptorFor("session-123")).toEqual({
      summary: store.session(),
    });
  });

  test("clears a released structural wait when its source retires", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.claimTurn("turn-origin", handle, 110);
    coordinator.recordStructuralWait("turn-origin", {
      kind: "confirmation",
      responseId: "confirmation-123",
    });
    coordinator.releaseTurn("turn-origin");
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "waiting",
    );

    expect(
      coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "computer_use_stopped",
      }),
    ).toBe(true);
    expect(coordinator.descriptorFor("session-123")).toEqual({
      summary: expect.objectContaining({
        status: "interrupted",
        endReason: "computer_use_stopped",
      }),
    });
  });

  test("reconciles one stale revision without moving the first boundary", () => {
    const store = createDependencies(
      activeSession({
        firstIncludedAt: 80,
        firstIncludedMessageId: "assistant-earliest",
        lastOwnedMessageId: "assistant-earliest",
        revision: 3,
      }),
    );
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(
      coordinator,
      store.session(),
      "browser-source",
      7,
    );
    coordinator.acceptTurn("turn-123");
    coordinator.trackPersistedRow("turn-123", "assistant-later", 90);
    store.forceStale();
    expect(coordinator.claimTurn("turn-123", handle, 120)).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(store.session()).toMatchObject({
      firstIncludedAt: 80,
      firstIncludedMessageId: "assistant-earliest",
      lastOwnedMessageId: "assistant-later",
      lastActivityAt: 120,
    });
  });

  test("keeps ownership while draining and removes runtime hints at terminal", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.acceptTurn("turn-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 110);
    coordinator.claimTurn("turn-123", handle, 120);
    coordinator.retireSource(handle);
    expect(coordinator.beginDraining("turn-123")).toBe(true);
    expect(coordinator.descriptorFor("session-123")?.runtimeState).toBe(
      "finishing",
    );
    coordinator.trackPersistedRow("turn-123", "assistant-final", 130);
    expect(coordinator.getTurnOwner("turn-123")?.id).toBe("session-123");

    expect(
      coordinator.finalizeTurn({
        turnId: "turn-123",
        status: "completed",
        endedAt: 140,
        endReason: "settled",
        lastActivityAt: 130,
      }),
    ).toBe(true);
    expect(coordinator.hasResidentWork()).toBe(false);
    expect(coordinator.getTurnOwner("turn-123")).toBeUndefined();
    expect(coordinator.descriptorFor("session-123")).toEqual({
      summary: expect.objectContaining({
        status: "completed",
        endedAt: 140,
        lastOwnedMessageId: "assistant-final",
      }),
    });
    const nextHandle = coordinator.activateSource({
      sourceId: "computer-source",
      generation: 1,
      mode: "computer_use",
      sourceStartedAt: 150,
    });
    expect(nextHandle).toMatchObject({
      id: "session-created",
      generation: 1,
      activation: 2,
    });
    coordinator.acceptTurn("turn-stale-callback");
    expect(
      coordinator.claimTurn("turn-stale-callback", handle, 160),
    ).toBeUndefined();
    coordinator.acceptTurn("turn-next");
    expect(coordinator.claimTurn("turn-next", nextHandle!, 160)).toMatchObject({
      id: "session-created",
    });
    expect(store.publications()).toBeGreaterThan(0);
  });

  test("retries an earlier failed metadata stamp when a later row persists", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.acceptTurn("turn-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    store.failStamp("tool-result-123");
    coordinator.claimTurn("turn-123", handle, 110);
    coordinator.trackPersistedRow("turn-123", "tool-result-123", 120);

    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
    store.allowStamp("tool-result-123");
    coordinator.trackPersistedRow("turn-123", "assistant-456", 130);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-456",
    });
    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
      { messageId: "tool-result-123", sessionId: "session-123" },
      { messageId: "assistant-456", sessionId: "session-123" },
    ]);
  });

  test("retries a failed metadata stamp before releasing turn state", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    coordinator.releaseTurn("turn-123");

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("retries a failed final row before terminal persistence", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    expect(
      coordinator.finalizeTurn({
        turnId: "turn-123",
        status: "completed",
        endedAt: 130,
        endReason: "completed",
      }),
    ).toBe(true);

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      status: "completed",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("waits for every source-lifetime turn before terminal persistence", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = coordinator.activateSource({
      sourceId: "camera-source",
      generation: 1,
      mode: "live_vision",
      sourceStartedAt: 100,
      lifetime: "source",
    });
    expect(handle).toBeDefined();
    coordinator.acceptTurn("camera-run");
    coordinator.claimTurn("camera-run", handle!, 100);
    coordinator.acceptTurn("voice-turn");
    coordinator.claimTurn("voice-turn", handle!, 110);
    coordinator.trackPersistedRow("voice-turn", "assistant-123", 120);
    expect(coordinator.keepsSessionOpenAfterTurn("voice-turn")).toBe(true);

    expect(
      coordinator.retireSource(handle!, {
        status: "interrupted",
        endReason: "camera_lost",
      }),
    ).toBe(true);
    expect(coordinator.getTerminalDisposition("voice-turn")).toEqual({
      status: "interrupted",
      endReason: "camera_lost",
    });
    coordinator.releaseTurn("voice-turn");
    expect(store.session().status).toBe("active");

    coordinator.releaseTurn("camera-run");
    expect(store.session()).toMatchObject({
      status: "interrupted",
      endReason: "camera_lost",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("transfers a handoff owner without reopening source eligibility", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.acceptTurn("turn-123");
    coordinator.claimTurn("turn-123", handle, 110);
    coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    expect(coordinator.transferTurn("turn-123", "turn-456")).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(coordinator.getTurnOwner("turn-123")).toBeUndefined();
    expect(coordinator.getTurnOwner("turn-456")).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    coordinator.trackPersistedRow("turn-456", "assistant-456", 130);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-456",
    });
  });

  test("repairs tracked rows before a handoff discards their turn state", () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = registerSource(coordinator, store.session());
    coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    coordinator.transferTurn("turn-123", "turn-456");

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });
});
