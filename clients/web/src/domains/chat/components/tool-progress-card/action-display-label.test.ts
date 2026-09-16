import { expect, test } from "bun:test";

import { resolveActionDisplayLabel } from "./action-display-label";

const translate = (key: string) => `localized:${key}`;

test("explicit activity takes precedence over the action and fallback", () => {
  expect(
    resolveActionDisplayLabel(
      {
        activity: "Checking the release",
        actionDisplayKey: "terminal",
        fallback: "Legacy command",
      },
      translate,
    ),
  ).toBe("Checking the release");
});

test("resolves a typed action through the localized catalog key", () => {
  expect(
    resolveActionDisplayLabel(
      { actionDisplayKey: "terminal", fallback: "Legacy command" },
      translate,
    ),
  ).toBe("localized:actionDisplay.terminal");
});

test("uses the legacy label when no activity or action is available", () => {
  expect(
    resolveActionDisplayLabel({ fallback: "Legacy command" }, translate),
  ).toBe("Legacy command");
});
