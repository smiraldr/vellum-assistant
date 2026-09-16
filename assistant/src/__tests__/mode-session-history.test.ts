import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import type { ModeSessionDescriptor } from "../api/mode-session.js";
import type { ConversationMessage } from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { beginConversationModeSession } from "../persistence/conversation-mode-sessions.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

interface MessagesResponse {
  messages: ConversationMessage[];
  modeSessions?: ModeSessionDescriptor[];
}

describe("mode-session history projection", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversation_mode_sessions");
    db.run("DELETE FROM conversations");
  });

  test("returns same-conversation summaries, membership, aliases, and activity", async () => {
    const conversation = createConversation();
    expect(
      beginConversationModeSession({
        id: "session-123",
        conversationId: conversation.id,
        mode: "browser",
        sourceStartedAt: 100,
      }).ok,
    ).toBe(true);
    expect(
      beginConversationModeSession({
        id: "session-requested",
        conversationId: conversation.id,
        mode: "computer_use",
        sourceStartedAt: 200,
      }).ok,
    ).toBe(true);

    await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "First" }]),
      {
        id: "assistant-123",
        metadata: {
          modeSession: { mode: "browser", id: "session-123" },
          sentAt: 120,
        },
        skipIndexing: true,
      },
    );
    await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Second" }]),
      {
        id: "assistant-456",
        metadata: {
          modeSession: { mode: "browser", id: "session-123" },
          sentAt: 180,
        },
        skipIndexing: true,
      },
    );

    const response = (await handleListMessages({
      queryParams: {
        conversationId: conversation.id,
        modeSessionIds: "session-requested",
      },
    })) as unknown as MessagesResponse;

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).toMatchObject({
      id: "assistant-123",
      mergedMessageIds: ["assistant-456"],
      modeSession: { mode: "browser", id: "session-123" },
      modeSessionActivity: { firstAt: 120, lastAt: 180 },
    });
    expect(
      response.modeSessions?.map((descriptor) => descriptor.summary.id).sort(),
    ).toEqual(["session-123", "session-requested"]);
  });

  test("drops copied membership without a child-owned lifecycle record", async () => {
    const parent = createConversation();
    const child = createConversation();
    expect(
      beginConversationModeSession({
        id: "session-parent",
        conversationId: parent.id,
        mode: "browser",
        sourceStartedAt: 100,
      }).ok,
    ).toBe(true);
    await addMessage(
      child.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Copied" }]),
      {
        metadata: {
          modeSession: { mode: "browser", id: "session-parent" },
        },
        skipIndexing: true,
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: child.id },
    })) as unknown as MessagesResponse;

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).not.toHaveProperty("modeSession");
    expect(response.messages[0]).not.toHaveProperty("modeSessionActivity");
    expect(response.modeSessions).toBeUndefined();
  });

  test("bounds and validates explicitly requested IDs", async () => {
    const conversation = createConversation();
    const ids = Array.from({ length: 101 }, (_, index) => `session-${index}`);
    await expect(
      handleListMessages({
        queryParams: {
          conversationId: conversation.id,
          modeSessionIds: ids.join(","),
        },
      }),
    ).rejects.toThrow("modeSessionIds contains an invalid session ID");
  });
});
