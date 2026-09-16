/**
 * Tests for `ActivityStepsPanel` — the two-level activity-steps side drawer.
 *
 *  - Level 1 renders the phase-grouped timeline (phase headers + step pills)
 *    from the payload snapshot when no live group resolves.
 *  - Clicking a tool step drills into the level-2 detail (technical details +
 *    output) with an "All steps" back button; back returns to the timeline.
 *  - Clicking a thinking step drills into the reasoning text.
 *  - The header shows the run summary + step count, and the close button
 *    fires `onClose`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";

// The viewer store and chat-session-store (pulled in transitively) import the
// generated daemon SDK, which isn't built in CI/worktree checkouts. Stub all
// endpoints so the module loads; the panel never invokes them.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { ActivityStepsPanel } =
  await import("@/domains/chat/components/activity-steps-panel");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { useTurnStore } = await import("@/domains/chat/turn-store");

afterEach(() => {
  cleanup();
  useTurnStore.setState({ phase: "idle" });
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    name: string;
    status?: "running" | "completed" | "error";
  },
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

const BASH = makeToolCall({
  id: "tc-1",
  name: "bash",
  status: "completed",
  input: { command: "git status", activity: "Checking git status" },
  result: "On branch main",
  startedAt: 0,
  completedAt: 2_000,
});

const THINKING_TEXT =
  "I should check the repository state before doing anything else.";

const ITEMS: ToolCallCardItem[] = [
  { kind: "thinking", text: THINKING_TEXT, startedAt: 0, completedAt: 500 },
  { kind: "toolCall", toolCall: BASH },
];

function renderPanel(onClose: () => void = () => {}) {
  return render(
    <ActivityStepsPanel
      payload={{ items: ITEMS, toolCalls: [BASH] }}
      onClose={onClose}
    />,
  );
}

function seedTranscript(messages: DisplayMessage[]): void {
  act(() => {
    useChatSessionStore.setState({
      snapshot: {
        messages,
        seq: null,
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
      },
    });
  });
}

describe("ActivityStepsPanel — level 1 timeline", () => {
  test("renders phase headers and step pills for the snapshot items", () => {
    const { getAllByTestId, getByLabelText } = renderPanel();
    // Two phases: "Thinking" and "Working" (bash).
    const phases = getAllByTestId("phase-header");
    expect(phases.length).toBe(2);
    // The thinking step renders as a clickable pill.
    expect(getByLabelText("View thinking")).toBeTruthy();
    // The tool step renders its pill with the activity label.
    expect(
      getByLabelText("View details: Checking git status").textContent,
    ).toContain("Checking git status");
  });

  test("header shows the run summary and step count", () => {
    const { getByText } = renderPanel();
    // Timing data present → duration summary.
    expect(getByText(/Worked for/)).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
  });

  test("active trailing thinking settles while awaiting user input", () => {
    const items: ToolCallCardItem[] = [
      { kind: "toolCall", toolCall: BASH },
      { kind: "thinking", text: "Preparing the next step" },
    ];
    useTurnStore.setState({ phase: "thinking" });
    const { getAllByText, queryByText, getByText } = render(
      <ActivityStepsPanel
        payload={{ items, toolCalls: [BASH], active: true }}
        onClose={() => {}}
      />,
    );

    expect(getAllByText("Thinking").length).toBeGreaterThan(0);
    expect(queryByText(/Worked for/)).toBeNull();

    act(() => useTurnStore.setState({ phase: "awaiting_user_input" }));
    expect(getByText(/Worked for/)).toBeTruthy();
  });

  test("an open thinking detail follows appended steps and a blank-to-prose boundary", () => {
    const nextTool = makeToolCall({
      id: "tc-2",
      name: "bash",
      status: "completed",
      input: { command: "git diff", activity: "Checking the diff" },
      startedAt: 2_000,
      completedAt: 3_000,
    });
    const message = (
      thinking: string,
      includeNextTool: boolean,
      trailingText: string,
    ): DisplayMessage => ({
      id: "m-live",
      role: "assistant",
      contentBlocks: [
        { type: "tool_use", toolCall: BASH },
        { type: "text", text: "\n" },
        { type: "thinking", thinking },
        ...(includeNextTool
          ? ([
              { type: "text", text: "  " },
              { type: "tool_use", toolCall: nextTool },
            ] as const)
          : []),
        { type: "text", text: trailingText },
      ],
    });

    useTurnStore.setState({ phase: "thinking" });
    seedTranscript([message("partial reasoning", false, "\n")]);
    const { getByLabelText, getByRole, getByText } = render(
      <ActivityStepsPanel
        payload={{
          messageId: "m-live",
          groupIndex: 0,
          items: ITEMS,
          toolCalls: [BASH],
          active: true,
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(getByLabelText("View thinking"));
    expect(getByText("partial reasoning")).toBeTruthy();

    seedTranscript([message("partial reasoning and more", true, "\n")]);
    expect(getByText("partial reasoning and more")).toBeTruthy();

    seedTranscript([
      message("partial reasoning and more", true, "Visible response."),
    ]);
    fireEvent.click(getByRole("button", { name: /back to all steps/i }));
    expect(getByText("3 steps")).toBeTruthy();
    expect(getByText(/Worked for/)).toBeTruthy();
  });

  test("close button fires onClose", () => {
    let closed = false;
    const { getByLabelText } = renderPanel(() => {
      closed = true;
    });
    fireEvent.click(getByLabelText("Close steps"));
    expect(closed).toBe(true);
  });
});

describe("ActivityStepsPanel — level 2 drill-in", () => {
  test("clicking a tool step shows its detail with a back button", () => {
    const {
      getAllByText,
      getByLabelText,
      getByText,
      getByRole,
      queryByTestId,
      queryByText,
    } = renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    // Level 2: the tool detail, headed by the tool and showing its output.
    expect(getByText("Run Command")).toBeTruthy();
    expect(getByText("On branch main")).toBeTruthy();
    // The timeline is replaced, and the header swaps to the step's title with
    // the back chevron on its left (the run summary is gone). The header owns
    // the activity sentence, so it renders once and the body does not echo it.
    expect(queryByTestId("phase-header")).toBeNull();
    expect(queryByText(/Worked for/)).toBeNull();
    expect(getAllByText("Checking git status")).toHaveLength(1);
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });

  test("the back button returns to the timeline", () => {
    const { getByLabelText, getByRole, getAllByTestId, queryByText } =
      renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    fireEvent.click(getByRole("button", { name: /back to all steps/i }));
    expect(getAllByTestId("phase-header").length).toBe(2);
    // The detail body (title-cased tool name) is gone again.
    expect(queryByText("Bash")).toBeNull();
  });

  test("clicking a thinking step shows the full reasoning text", () => {
    const { getByLabelText, getByText, getByRole } = renderPanel();
    fireEvent.click(getByLabelText("View thinking"));
    // The full (untruncated) reasoning renders in the detail level.
    expect(getByText(THINKING_TEXT)).toBeTruthy();
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });
});
