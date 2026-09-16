import type { ModeSession } from "../api/mode-session.js";
import type { BrowserOperationLifecycle } from "../browser/operations.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "./conversation-mode-session.js";

export type { BrowserOperationLifecycle } from "../browser/operations.js";

type ModeSessionCoordinator = Pick<
  ConversationModeSessionCoordinator,
  | "activateSource"
  | "claimTurn"
  | "getTurnOwner"
  | "recordActivity"
  | "retireSource"
>;

export interface BrowserOperationToken {
  readonly turnId: string;
  readonly lifecycle: Exclude<BrowserOperationLifecycle, "status">;
  readonly owner: ModeSession;
  readonly handle?: ModeSessionSourceHandle;
}

const BROWSER_SOURCE_ID = "browser";

/** Maps typed browser operations onto the shared session coordinator. */
export class BrowserModeSessionProducer {
  readonly #coordinator: ModeSessionCoordinator;
  readonly #generation: number;
  #activeHandle?: ModeSessionSourceHandle;

  constructor(coordinator: ModeSessionCoordinator, generation = 1) {
    this.#coordinator = coordinator;
    this.#generation = generation;
  }

  beginOperation(input: {
    turnId: string;
    lifecycle: BrowserOperationLifecycle;
    at: number;
  }): BrowserOperationToken | undefined {
    if (input.lifecycle === "status") {
      return undefined;
    }

    const existingOwner = this.#coordinator.getTurnOwner(input.turnId);
    if (existingOwner) {
      const handle = this.#activeHandle;
      return {
        turnId: input.turnId,
        lifecycle: input.lifecycle,
        owner: existingOwner,
        ...(handle &&
        (input.lifecycle === "terminal" || handle.id === existingOwner.id)
          ? { handle }
          : {}),
      };
    }

    if (input.lifecycle === "terminal") {
      const handle = this.#activeHandle;
      if (!handle) {
        return undefined;
      }
      const owner = this.#coordinator.claimTurn(input.turnId, handle, input.at);
      if (!owner || owner.id !== handle.id) {
        return undefined;
      }
      return {
        turnId: input.turnId,
        lifecycle: input.lifecycle,
        owner,
        handle,
      };
    }

    const handle = this.#coordinator.activateSource({
      sourceId: BROWSER_SOURCE_ID,
      generation: this.#generation,
      mode: "browser",
      sourceStartedAt: input.at,
    });
    if (!handle) {
      return undefined;
    }
    const owner = this.#coordinator.claimTurn(input.turnId, handle, input.at);
    if (!owner) {
      return undefined;
    }
    if (owner.id === handle.id) {
      this.#activeHandle = handle;
    }
    return {
      turnId: input.turnId,
      lifecycle: input.lifecycle,
      owner,
      ...(owner.id === handle.id ? { handle } : {}),
    };
  }

  finishOperation(
    token: BrowserOperationToken | undefined,
    outcome: {
      at: number;
      isError: boolean;
      cancelled: boolean;
      terminalReason?: "browser_closed" | "browser_detached";
    },
  ): boolean {
    if (!token) {
      return false;
    }

    const handle = token.handle;
    if (outcome.isError || outcome.cancelled) {
      if (!handle || !this.#isCurrent(handle)) {
        return false;
      }
      return this.#retire(handle, {
        status: "interrupted",
        endReason: outcome.cancelled
          ? "browser_operation_cancelled"
          : "browser_operation_failed",
      });
    }

    if (token.lifecycle === "terminal") {
      if (!handle || !this.#isCurrent(handle)) {
        return false;
      }
      return this.#retire(handle, {
        status: "completed",
        endReason: outcome.terminalReason ?? "browser_closed",
      });
    }

    return this.#coordinator.recordActivity(token.turnId, outcome.at);
  }

  #isCurrent(handle: ModeSessionSourceHandle): boolean {
    const active = this.#activeHandle;
    return (
      active?.sourceId === handle.sourceId &&
      active.generation === handle.generation &&
      active.activation === handle.activation &&
      active.id === handle.id
    );
  }

  #retire(
    handle: ModeSessionSourceHandle,
    disposition: ModeSessionTerminalDisposition,
  ): boolean {
    const retired = this.#coordinator.retireSource(handle, disposition);
    if (retired && this.#isCurrent(handle)) {
      this.#activeHandle = undefined;
    }
    return retired;
  }
}
