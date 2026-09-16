export type ActionDisplayKey =
  | "click"
  | "type"
  | "keyPress"
  | "scroll"
  | "drag"
  | "hover"
  | "observe"
  | "navigate"
  | "terminal";

export const ACTION_DISPLAY_TRANSLATION_KEYS = {
  click: "actionDisplay.click",
  type: "actionDisplay.type",
  keyPress: "actionDisplay.keyPress",
  scroll: "actionDisplay.scroll",
  drag: "actionDisplay.drag",
  hover: "actionDisplay.hover",
  observe: "actionDisplay.observe",
  navigate: "actionDisplay.navigate",
  terminal: "actionDisplay.terminal",
} as const satisfies Record<ActionDisplayKey, string>;

type ActionDisplayTranslationKey =
  (typeof ACTION_DISPLAY_TRANSLATION_KEYS)[ActionDisplayKey];

export function resolveActionDisplayLabel(
  input: {
    activity?: string | null;
    actionDisplayKey?: ActionDisplayKey | null;
    fallback?: string | null;
  },
  translate: (key: ActionDisplayTranslationKey) => string,
): string {
  if (input.activity) {
    return input.activity;
  }
  if (input.actionDisplayKey) {
    return translate(ACTION_DISPLAY_TRANSLATION_KEYS[input.actionDisplayKey]);
  }
  return input.fallback ?? "";
}
