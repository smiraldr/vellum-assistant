/**
 * True when a tool call is backed by the host computer-use capability.
 *
 * Skills expose their selected tool in structured input. Calls recovered only
 * from `_raw` retain their legacy behavior because this helper deliberately
 * does not parse a second input representation.
 */
export function isComputerUseToolCall(name: string, input: unknown): boolean {
  if (name.startsWith("computer_use_")) {
    return true;
  }
  if (name !== "skill_execute" || input === null || typeof input !== "object") {
    return false;
  }
  const tool = (input as Record<string, unknown>).tool;
  return typeof tool === "string" && tool.startsWith("computer_use_");
}
