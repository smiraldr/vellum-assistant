import { describe, expect, test } from "bun:test";

import { isComputerUseToolCall } from "./computer-use-tool.js";

describe("isComputerUseToolCall", () => {
  test("recognizes direct and skill-wrapped computer-use calls", () => {
    expect(isComputerUseToolCall("computer_use_click", {})).toBe(true);
    expect(
      isComputerUseToolCall("skill_execute", { tool: "computer_use_type" }),
    ).toBe(true);
  });

  test("rejects unrelated media tools and malformed skill input", () => {
    expect(isComputerUseToolCall("browser_screenshot", {})).toBe(false);
    expect(isComputerUseToolCall("file_read", {})).toBe(false);
    expect(isComputerUseToolCall("image_generate", {})).toBe(false);
    expect(isComputerUseToolCall("skill_execute", null)).toBe(false);
    expect(isComputerUseToolCall("skill_execute", "computer_use_click")).toBe(
      false,
    );
    expect(isComputerUseToolCall("skill_execute", { tool: 42 })).toBe(false);
    expect(
      isComputerUseToolCall("skill_execute", {
        tool: "browser_screenshot",
      }),
    ).toBe(false);
  });

  test("does not classify raw-only recovered skill input", () => {
    expect(
      isComputerUseToolCall("skill_execute", {
        _raw: '{"tool":"computer_use_click"}',
      }),
    ).toBe(false);
  });
});
