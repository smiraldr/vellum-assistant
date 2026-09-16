import { describe, expect, test } from "bun:test";

import {
  activeModeSessionIdsForRefresh,
  aggregateBackgroundToolCompletions,
  aggregateModeSessionDescriptors,
  aggregateSubagentNotifications,
} from "@/domains/chat/transcript/use-history-pagination";
import type { ModeSessionDescriptor } from "@vellumai/assistant-api";
import type { RuntimeSubagentNotification } from "@/domains/chat/api/messages";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

function notif(
  subagentId: string,
  status: string,
): RuntimeSubagentNotification {
  return {
    subagentId,
    label: subagentId,
    status,
  } as RuntimeSubagentNotification;
}

function completion(id: string): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command: `echo ${id}`,
    startedAt: 0,
    status: "completed",
  };
}

function page(
  subagentNotifications?: RuntimeSubagentNotification[],
  backgroundToolCompletions?: BackgroundTaskEntry[],
  modeSessions?: ModeSessionDescriptor[],
  messages: PaginatedHistoryResult["messages"] = [],
): PaginatedHistoryResult {
  return {
    messages,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    ...(subagentNotifications ? { subagentNotifications } : {}),
    ...(backgroundToolCompletions ? { backgroundToolCompletions } : {}),
    ...(modeSessions ? { modeSessions } : {}),
  };
}

function descriptor(
  id: string,
  revision: number,
  status: "active" | "completed" = "active",
): ModeSessionDescriptor {
  const base = {
    id,
    conversationId: "conv-1",
    mode: "computer_use" as const,
    sourceStartedAt: 1,
    firstIncludedAt: 1,
    firstIncludedMessageId: "message-1",
    lastActivityAt: 2,
    lastOwnedMessageId: "message-1",
    revision,
  };
  return status === "active"
    ? { summary: { ...base, status, endedAt: null, endReason: null } }
    : {
        summary: {
          ...base,
          status,
          endedAt: 2,
          endReason: "completed",
        },
      };
}

describe("aggregateSubagentNotifications", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateSubagentNotifications(undefined)).toBeUndefined();
    expect(aggregateSubagentNotifications([])).toBeUndefined();
  });

  test("returns undefined when no page carries notifications", () => {
    expect(aggregateSubagentNotifications([page(), page()])).toBeUndefined();
  });

  test("returns a single page's notifications", () => {
    const result = aggregateSubagentNotifications([
      page([notif("a", "completed")]),
    ]);
    expect(result?.map((n) => n.subagentId)).toEqual(["a"]);
  });

  test("includes notifications from OLDER pages, oldest-first (regression: aborted-early subagent)", () => {
    // pages[0] = latest page, pages[1] = older. The aborted subagent's
    // notification lives only in the older page; it must still be aggregated.
    const pages = [
      page([notif("completed-late", "completed")]),
      page([notif("aborted-early", "aborted")]),
    ];
    const result = aggregateSubagentNotifications(pages);
    expect(result?.map((n) => n.subagentId)).toEqual([
      "aborted-early",
      "completed-late",
    ]);
  });
});

describe("aggregateBackgroundToolCompletions", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateBackgroundToolCompletions(undefined)).toBeUndefined();
    expect(aggregateBackgroundToolCompletions([])).toBeUndefined();
  });

  test("returns undefined when no page carries completions", () => {
    expect(
      aggregateBackgroundToolCompletions([page(), page()]),
    ).toBeUndefined();
  });

  test("returns a single page's completions", () => {
    const result = aggregateBackgroundToolCompletions([
      page(undefined, [completion("bg-a")]),
    ]);
    expect(result?.map((c) => c.id)).toEqual(["bg-a"]);
  });

  test("concatenates completions from multiple pages, oldest-first", () => {
    // pages[0] = latest page, pages[1] = older. Completions from the older
    // page must come first so first-seen order is preserved for seeding.
    const pages = [
      page(undefined, [completion("bg-late"), completion("bg-latest")]),
      page(undefined, [completion("bg-early")]),
    ];
    const result = aggregateBackgroundToolCompletions(pages);
    expect(result?.map((c) => c.id)).toEqual([
      "bg-early",
      "bg-late",
      "bg-latest",
    ]);
  });
});

describe("mode session descriptor aggregation", () => {
  test("keeps the newest revision while preserving independent page content", () => {
    const result = aggregateModeSessionDescriptors([
      page(undefined, undefined, [descriptor("session-a", 2)]),
      page(undefined, undefined, [
        descriptor("session-a", 1),
        descriptor("session-b", 1, "completed"),
      ]),
    ]);
    expect(result.map(({ summary }) => [summary.id, summary.revision])).toEqual(
      [
        ["session-a", 2],
        ["session-b", 1],
      ],
    );
  });

  test("keeps a previously accepted newer descriptor across a stale response", () => {
    const accepted = descriptor("session-a", 2);
    const previous = [accepted];
    const result = aggregateModeSessionDescriptors(
      [page(undefined, undefined, [descriptor("session-a", 1)])],
      previous,
    );

    expect(result).toBe(previous);
    expect(result[0]).toBe(accepted);
  });

  test("reuses equal revisions while accepting independent descriptors", () => {
    const accepted = descriptor("session-a", 2);
    const next = aggregateModeSessionDescriptors(
      [
        page(undefined, undefined, [
          descriptor("session-a", 2),
          descriptor("session-b", 1),
        ]),
      ],
      [accepted],
    );

    expect(next[0]).toBe(accepted);
    expect(next[1]?.summary.id).toBe("session-b");
  });

  test("retains needed prior descriptors and drops absent settled records", () => {
    const active = descriptor("session-active", 2);
    const represented = descriptor("session-represented", 2, "completed");
    const absent = descriptor("session-absent", 2, "completed");
    const result = aggregateModeSessionDescriptors(
      [
        page(undefined, undefined, undefined, [
          {
            id: "message-1",
            role: "assistant",
            modeSession: {
              mode: "computer_use",
              id: "session-represented",
            },
          },
        ]),
      ],
      [active, represented, absent],
    );

    expect(result).toEqual([active, represented]);
  });

  test("refreshes only bounded active ids from all loaded pages", () => {
    expect(
      activeModeSessionIdsForRefresh([
        page(undefined, undefined, [descriptor("session-new", 1)]),
        page(undefined, undefined, [
          descriptor("session-old", 1),
          descriptor("session-done", 1, "completed"),
        ]),
      ]),
    ).toEqual(["session-new", "session-old"]);
  });
});
