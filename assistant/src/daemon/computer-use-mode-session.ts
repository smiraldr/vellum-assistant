import type { ModeSession } from "../api/mode-session.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
} from "./conversation-mode-session.js";

type ModeSessionCoordinator = Pick<
  ConversationModeSessionCoordinator,
  | "activateSource"
  | "beginDraining"
  | "claimTurn"
  | "getTurnOwner"
  | "recordActivity"
  | "retireSource"
>;

export interface ComputerUseSourceIdentity {
  sourceId: string;
  generation: number;
}

/** Maps validated host computer actions onto the shared session coordinator. */
export class ComputerUseModeSessionProducer {
  readonly #coordinator: ModeSessionCoordinator;
  #activeHandle?: ModeSessionSourceHandle;

  constructor(coordinator: ModeSessionCoordinator) {
    this.#coordinator = coordinator;
  }

  recordAction(input: {
    turnId: string;
    source: ComputerUseSourceIdentity;
    at: number;
  }): ModeSession | undefined {
    const existingOwner = this.#coordinator.getTurnOwner(input.turnId);
    if (existingOwner) {
      this.#coordinator.recordActivity(input.turnId, input.at);
      return existingOwner;
    }

    const handle = this.#coordinator.activateSource({
      ...input.source,
      mode: "computer_use",
      sourceStartedAt: input.at,
    });
    if (!handle) {
      return undefined;
    }
    this.#activeHandle = handle;
    return this.#coordinator.claimTurn(input.turnId, handle, input.at);
  }

  endTask(input: {
    turnId?: string;
    source: ComputerUseSourceIdentity;
  }): boolean {
    const handle = this.#activeHandle;
    if (
      !handle ||
      handle.sourceId !== input.source.sourceId ||
      handle.generation !== input.source.generation
    ) {
      return false;
    }

    this.#activeHandle = undefined;
    const retired = this.#coordinator.retireSource(handle);
    if (
      input.turnId &&
      this.#coordinator.getTurnOwner(input.turnId)?.id === handle.id
    ) {
      this.#coordinator.beginDraining(input.turnId);
    }
    return retired;
  }
}
