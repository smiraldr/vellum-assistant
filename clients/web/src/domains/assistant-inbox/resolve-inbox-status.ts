import type { PlatformGateState } from "@/hooks/use-platform-gate";

/**
 * What the Assistant Inbox shows for this assistant.
 *
 * - `unavailable`: no platform to ask (local mode, self-hosted assistant,
 *   or no session). Nothing to draw and no rail entry.
 * - `loading`: the reads that decide have not settled.
 * - `upgrade`: the org has no `managed_email` entitlement.
 * - `setup`: entitled, but the assistant has no address yet.
 * - `ready`: an address exists; the mailbox can be shown.
 */
export type InboxStatus =
  | "unavailable"
  | "loading"
  | "upgrade"
  | "setup"
  | "ready";

export interface InboxStatusInputs {
  gate: PlatformGateState;
  /** The platform assistant id resolved, or `null` while it has not. */
  platformAssistantId: string | null;
  /** `undefined` until the subscription has been read once. */
  entitlements: Record<string, unknown> | undefined;
  /** The subscription read failed and nothing is cached. */
  subscriptionFailed: boolean;
  /** `undefined` until the address list has been read once. */
  addressCount: number | undefined;
}

/**
 * Pure so the decision can be tested without the hooks that feed it. The
 * entitlement check follows the channels page: only an explicit denial (a
 * subscription payload whose `entitlements` omit `managed_email`) reads as
 * not entitled, so a transient billing failure never locks an entitled user
 * out of their own inbox.
 */
export function resolveInboxStatus(inputs: InboxStatusInputs): InboxStatus {
  if (inputs.gate !== "full") {
    return "unavailable";
  }
  if (inputs.entitlements) {
    if (inputs.entitlements.managed_email !== true) {
      return "upgrade";
    }
  } else if (!inputs.subscriptionFailed) {
    return "loading";
  }
  if (!inputs.platformAssistantId || inputs.addressCount === undefined) {
    return "loading";
  }
  return inputs.addressCount > 0 ? "ready" : "setup";
}
