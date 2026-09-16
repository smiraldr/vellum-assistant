import type { ModeSessionMode } from "../api/mode-session.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "../daemon/conversation-mode-session.js";
import type { LiveVoiceSightSource } from "./protocol.js";

type ModeSessionCoordinator = Pick<
  ConversationModeSessionCoordinator,
  | "activateSource"
  | "claimTurn"
  | "recordActivity"
  | "releaseTurn"
  | "retireSource"
  | "trackPersistedRow"
>;

interface CameraRun {
  readonly epoch: number;
  readonly source: LiveVoiceSightSource;
  readonly handle: ModeSessionSourceHandle;
  readonly syntheticTurnId: string;
  pendingFrames: number;
  retired: boolean;
}

export interface CameraFrameToken {
  readonly owner: ModeSessionSourceHandle;
  readonly epoch: number;
  readonly activation: number;
}

function modeFor(source: LiveVoiceSightSource): ModeSessionMode {
  return source === "ambient" ? "ambient" : "live_vision";
}

/** Maps one voice session's negotiated camera epochs onto durable sessions. */
export class CameraModeSessionProducer {
  readonly #coordinator: ModeSessionCoordinator;
  readonly #sourceId: string;
  readonly #runs = new Map<number, CameraRun>();
  readonly #pendingFrameTokens = new Set<CameraFrameToken>();
  #activeRun?: CameraRun;
  #highestEpoch = 0;

  constructor(coordinator: ModeSessionCoordinator, voiceSessionId: string) {
    this.#coordinator = coordinator;
    this.#sourceId = `live-voice-camera:${voiceSessionId}`;
  }

  start(
    epoch: number,
    source: LiveVoiceSightSource = "live",
    at = Date.now(),
  ): ModeSessionSourceHandle | undefined {
    const known = this.#runs.get(epoch);
    if (known) {
      return !known.retired && known.source === source
        ? known.handle
        : undefined;
    }
    if (epoch <= this.#highestEpoch) {
      return undefined;
    }

    if (this.#activeRun) {
      this.#retire(this.#activeRun, {
        status: "interrupted",
        endReason: "camera_source_replaced",
      });
    }

    const handle = this.#coordinator.activateSource({
      sourceId: this.#sourceId,
      generation: epoch,
      mode: modeFor(source),
      sourceStartedAt: at,
      lifetime: "source",
    });
    if (!handle) {
      return undefined;
    }

    const syntheticTurnId = `${this.#sourceId}:${epoch}:${handle.activation}`;
    const owner = this.#coordinator.claimTurn(syntheticTurnId, handle, at);
    if (!owner || owner.id !== handle.id) {
      this.#coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "camera_start_refused",
      });
      this.#coordinator.releaseTurn(syntheticTurnId);
      return undefined;
    }

    const run: CameraRun = {
      epoch,
      source,
      handle,
      syntheticTurnId,
      pendingFrames: 0,
      retired: false,
    };
    this.#runs.set(epoch, run);
    this.#highestEpoch = epoch;
    this.#activeRun = run;
    return handle;
  }

  captureTurn(): ModeSessionSourceHandle | undefined {
    return this.#activeRun?.handle;
  }

  holdDelivery(
    turnId: string,
    at = Date.now(),
  ): ModeSessionSourceHandle | undefined {
    const handle = this.captureTurn();
    if (!handle) {
      return undefined;
    }
    const owner = this.#coordinator.claimTurn(turnId, handle, at);
    return owner?.id === handle.id ? handle : undefined;
  }

  releaseDelivery(turnId: string): void {
    this.#coordinator.releaseTurn(turnId);
  }

  beginFrame(
    epoch: number,
    source: LiveVoiceSightSource | undefined,
  ): CameraFrameToken | undefined {
    const run = this.#activeRun;
    if (
      !run ||
      run.retired ||
      run.epoch !== epoch ||
      (source !== undefined && source !== run.source)
    ) {
      return undefined;
    }
    run.pendingFrames += 1;
    const token = {
      owner: run.handle,
      epoch: run.epoch,
      activation: run.handle.activation,
    };
    this.#pendingFrameTokens.add(token);
    return token;
  }

  finishFrame(
    token: CameraFrameToken | undefined,
    persisted?: { messageId: string; at: number },
  ): void {
    if (!token || !this.#pendingFrameTokens.delete(token)) {
      return;
    }
    const run = this.#runs.get(token.epoch);
    if (!run || run.handle.activation !== token.activation) {
      return;
    }
    try {
      if (
        persisted &&
        this.#coordinator.recordActivity(run.syntheticTurnId, persisted.at)
      ) {
        this.#coordinator.trackPersistedRow(
          run.syntheticTurnId,
          persisted.messageId,
          persisted.at,
        );
        this.#coordinator.recordActivity(run.syntheticTurnId, persisted.at);
      }
    } finally {
      run.pendingFrames = Math.max(0, run.pendingFrames - 1);
      this.#releaseIfSettled(run);
    }
  }

  end(
    epoch: number,
    disposition: ModeSessionTerminalDisposition = {
      status: "completed",
      endReason: "camera_stopped",
    },
  ): boolean {
    const run = this.#runs.get(epoch);
    if (!run || run.retired) {
      return false;
    }
    return this.#retire(run, disposition);
  }

  close(disposition: ModeSessionTerminalDisposition): boolean {
    const run = this.#activeRun;
    return run ? this.#retire(run, disposition) : false;
  }

  #retire(
    run: CameraRun,
    disposition: ModeSessionTerminalDisposition,
  ): boolean {
    if (
      run.retired ||
      !this.#coordinator.retireSource(run.handle, disposition)
    ) {
      return false;
    }
    run.retired = true;
    if (this.#activeRun === run) {
      this.#activeRun = undefined;
    }
    this.#releaseIfSettled(run);
    return true;
  }

  #releaseIfSettled(run: CameraRun): void {
    if (run.retired && run.pendingFrames === 0) {
      this.#coordinator.releaseTurn(run.syntheticTurnId);
    }
  }
}
