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
