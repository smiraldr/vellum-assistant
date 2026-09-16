import { v7 as uuidv7 } from "uuid";

import type {
  ModeSession,
  ModeSessionDescriptor,
  ModeSessionMode,
  ModeSessionSummary,
} from "../api/mode-session.js";
import { modeSessionRowStartsDisplay } from "../api/mode-session.js";
import { updateMessageMetadata } from "../persistence/conversation-crud.js";
import {
  advanceConversationModeSessionRevision,
  beginConversationModeSession,
  finalizeConversationModeSession,
  getConversationModeSession,
  type ModeSessionWriteResult,
  updateConversationModeSessionActivity,
  updateConversationModeSessionBoundaries,
} from "../persistence/conversation-mode-sessions.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";

export type ModeSessionStructuralKind =
  | "question"
  | "confirmation"
  | "secret"
  | "surface";

export interface ModeSessionSourceRegistration {
  sourceId: string;
  generation: number;
  session: ModeSessionSummary;
}

export interface ModeSessionSourceReference {
  sourceId: string;
  generation: number;
  activation: number;
}

export interface ModeSessionSourceHandle
  extends ModeSessionSourceReference, ModeSession {}

export interface ModeSessionSourceActivation {
  sourceId: string;
  generation: number;
  mode: ModeSessionMode;
  sourceStartedAt: number;
  lifetime?: "turn" | "source";
}

export interface ModeSessionStructuralResponse {
  kind: ModeSessionStructuralKind;
  responseId: string;
}

export interface ModeSessionTerminalDisposition {
  status: "completed" | "interrupted";
  endReason: string;
}

interface TrackedRow {
  id: string;
  at: number;
  stamped: boolean;
  startsDisplayBoundary: boolean;
}

interface TurnState {
  owner?: ModeSession;
  rows: TrackedRow[];
  runtimeState?: "waiting" | "finishing";
  terminalDisposition?: ModeSessionTerminalDisposition;
}

interface SourceState {
  generation: number;
  activation: number;
  session: ModeSession;
  lifetime: "turn" | "source";
}

interface StructuralAssociation {
  conversationId: string;
  kind: ModeSessionStructuralKind;
  owner: ModeSession;
}

export interface ConversationModeSessionCoordinatorDependencies {
  createId(): string;
  beginSession(input: {
    id: string;
    conversationId: string;
    mode: ModeSessionMode;
    sourceStartedAt: number;
  }): ModeSessionWriteResult;
  getSession(conversationId: string, id: string): ModeSessionSummary | null;
  updateActivity(input: {
    id: string;
    conversationId: string;
    expectedRevision: number;
    lastActivityAt: number;
    lastOwnedMessageId?: string | null;
  }): ModeSessionWriteResult;
  updateBoundaries(input: {
    id: string;
    conversationId: string;
    expectedRevision: number;
    firstIncluded: { at: number; messageId: string } | null;
    lastActivityAt: number;
    lastOwnedMessageId: string | null;
  }): ModeSessionWriteResult;
  advanceRevision(input: {
    id: string;
    conversationId: string;
    expectedRevision: number;
  }): ModeSessionWriteResult;
  finalize(input: {
    id: string;
    conversationId: string;
    expectedRevision: number;
    status: "completed" | "interrupted";
    endedAt: number | null;
    endReason: string;
    lastActivityAt?: number;
    lastOwnedMessageId?: string | null;
  }): ModeSessionWriteResult;
  stampMessage(messageId: string, owner: ModeSession): void;
  publishMessagesChanged(conversationId: string): void;
}

const defaultDependencies: ConversationModeSessionCoordinatorDependencies = {
  createId: uuidv7,
  beginSession: beginConversationModeSession,
  getSession: getConversationModeSession,
  updateActivity: updateConversationModeSessionActivity,
  updateBoundaries: updateConversationModeSessionBoundaries,
  advanceRevision: advanceConversationModeSessionRevision,
  finalize: (input) => {
    if (input.status === "completed") {
      if (input.endedAt === null) {
        throw new Error("Completed mode sessions require an end time");
      }
      return finalizeConversationModeSession({
        id: input.id,
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        status: "completed",
        endedAt: input.endedAt,
        endReason: input.endReason,
        ...(input.lastActivityAt !== undefined
          ? { lastActivityAt: input.lastActivityAt }
          : {}),
        ...(input.lastOwnedMessageId !== undefined
          ? { lastOwnedMessageId: input.lastOwnedMessageId }
          : {}),
      });
    }
    return finalizeConversationModeSession({
      id: input.id,
      conversationId: input.conversationId,
      expectedRevision: input.expectedRevision,
      status: "interrupted",
      endedAt: input.endedAt,
      endReason: input.endReason,
      ...(input.lastActivityAt !== undefined
        ? { lastActivityAt: input.lastActivityAt }
        : {}),
      ...(input.lastOwnedMessageId !== undefined
        ? { lastOwnedMessageId: input.lastOwnedMessageId }
        : {}),
    });
  },
  stampMessage: (messageId, owner) => {
    updateMessageMetadata(messageId, { modeSession: owner });
  },
  publishMessagesChanged: publishConversationMessagesChanged,
};

function sourceKey(sourceId: string): string {
  return sourceId;
}

function associationKey(
  kind: ModeSessionStructuralKind,
  responseId: string,
): string {
  return `${kind}:${responseId}`;
}

function lastStampedRow(rows: TrackedRow[]): TrackedRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.stamped) {
      return rows[index];
    }
  }
  return undefined;
}

/**
 * Conversation-local membership bookkeeping. Mode producers register their
 * durable active session and call these mechanical ownership operations; this
 * helper never decides when a mode should activate.
 */
export class ConversationModeSessionCoordinator {
  readonly #conversationId: string;
  readonly #dependencies: ConversationModeSessionCoordinatorDependencies;
  readonly #sessions = new Map<string, ModeSessionSummary>();
  readonly #sources = new Map<string, SourceState>();
  readonly #sourceActivations = new Map<string, number>();
  readonly #turns = new Map<string, TurnState>();
  readonly #structuralAssociations = new Map<string, StructuralAssociation>();
  readonly #retiredDispositions = new Map<
    string,
    ModeSessionTerminalDisposition
  >();

  constructor(
    conversationId: string,
    dependencies: ConversationModeSessionCoordinatorDependencies = defaultDependencies,
  ) {
    this.#conversationId = conversationId;
    this.#dependencies = dependencies;
  }

  registerSource(
    registration: ModeSessionSourceRegistration,
  ): ModeSessionSourceHandle | undefined {
    const { session } = registration;
    if (
      session.conversationId !== this.#conversationId ||
      session.status !== "active"
    ) {
      return undefined;
    }
    const key = sourceKey(registration.sourceId);
    const current = this.#sources.get(key);
    if (current && current.generation >= registration.generation) {
      return undefined;
    }
    const activation = (this.#sourceActivations.get(key) ?? 0) + 1;
    this.#sourceActivations.set(key, activation);
    this.#sessions.set(session.id, session);
    this.#sources.set(key, {
      generation: registration.generation,
      activation,
      session: { id: session.id, mode: session.mode },
      lifetime: "turn",
    });
    return {
      sourceId: registration.sourceId,
      generation: registration.generation,
      activation,
      id: session.id,
      mode: session.mode,
    };
  }

  activateSource(
    activation: ModeSessionSourceActivation,
  ): ModeSessionSourceHandle | undefined {
    const current = this.#sources.get(sourceKey(activation.sourceId));
    if (current && current.generation === activation.generation) {
      return this.#readActiveSession(current.session.id)
        ? {
            sourceId: activation.sourceId,
            generation: current.generation,
            activation: current.activation,
            ...current.session,
          }
        : undefined;
    }
    if (current && current.generation > activation.generation) {
      return undefined;
    }

    const result = this.#dependencies.beginSession({
      id: this.#dependencies.createId(),
      conversationId: this.#conversationId,
      mode: activation.mode,
      sourceStartedAt: activation.sourceStartedAt,
    });
    if (!result.ok || result.session.status !== "active") {
      return undefined;
    }
    const handle = this.registerSource({
      sourceId: activation.sourceId,
      generation: activation.generation,
      session: result.session,
    });
    const registered = this.#sources.get(sourceKey(activation.sourceId));
    if (registered) {
      registered.lifetime = activation.lifetime ?? "turn";
    }
    return handle;
  }

  retireSource(
    source: ModeSessionSourceReference,
    disposition?: ModeSessionTerminalDisposition,
  ): boolean {
    const key = sourceKey(source.sourceId);
    const currentSource = this.#sources.get(key);
    if (
      !currentSource ||
      currentSource.generation !== source.generation ||
      currentSource.activation !== source.activation
    ) {
      return false;
    }
    this.#sources.delete(key);
    if (disposition) {
      this.#retiredDispositions.set(currentSource.session.id, disposition);
      for (const turn of this.#turns.values()) {
        if (turn.owner?.id === currentSource.session.id) {
          turn.terminalDisposition = disposition;
          turn.runtimeState = "finishing";
        }
      }
    }
    const removedWait = this.#deleteAssociationsForOwner(
      currentSource.session.id,
    );
    if (removedWait && !disposition) {
      this.#clearRuntimeState(currentSource.session.id);
    }
    if (removedWait || disposition) {
      this.#publishRuntimeChange(currentSource.session.id);
    }
    if (disposition) {
      this.#finalizeRetiredSessionIfSettled(currentSource.session.id);
    }
    return true;
  }

  acceptTurn(
    turnId: string,
    structuralResponse?: ModeSessionStructuralResponse,
  ): ModeSession | undefined {
    const turn = this.#turns.get(turnId) ?? { rows: [] };
    this.#turns.set(turnId, turn);
    if (!structuralResponse || turn.owner) {
      return turn.owner;
    }

    const key = associationKey(
      structuralResponse.kind,
      structuralResponse.responseId,
    );
    const association = this.#structuralAssociations.get(key);
    if (!association || association.conversationId !== this.#conversationId) {
      return undefined;
    }
    this.#structuralAssociations.delete(key);

    const session = this.#readActiveSession(association.owner.id);
    if (!session || session.mode !== association.owner.mode) {
      return undefined;
    }
    turn.owner = association.owner;
    this.#clearRuntimeState(association.owner.id);
    this.#publishRuntimeChange(association.owner.id);
    this.#repairTrackedRows(turn);
    return turn.owner;
  }

  trackPersistedRow(
    turnId: string,
    messageId: string,
    at: number,
    options?: {
      startsDisplayBoundary?: boolean;
      publishMessagesChanged?: boolean;
    },
  ): void {
    const turn = this.#turns.get(turnId) ?? { rows: [] };
    this.#turns.set(turnId, turn);
    if (turn.rows.some((row) => row.id === messageId)) {
      return;
    }
    const row = {
      id: messageId,
      at,
      stamped: false,
      startsDisplayBoundary: options?.startsDisplayBoundary ?? true,
    };
    turn.rows.push(row);
    if (turn.owner) {
      this.#repairTrackedRows(turn, options?.publishMessagesChanged ?? true);
    }
  }

  claimTurn(
    turnId: string,
    sourceReference: ModeSessionSourceReference,
    activityAt: number,
  ): ModeSession | undefined {
    const turn = this.#turns.get(turnId) ?? { rows: [] };
    this.#turns.set(turnId, turn);
    if (turn.owner) {
      return turn.owner;
    }

    const source = this.#sources.get(sourceKey(sourceReference.sourceId));
    if (
      !source ||
      source.generation !== sourceReference.generation ||
      source.activation !== sourceReference.activation
    ) {
      return undefined;
    }
    const session = this.#readActiveSession(source.session.id);
    if (!session || session.mode !== source.session.mode) {
      return undefined;
    }

    turn.owner = source.session;
    this.#repairTrackedRows(turn);
    this.recordActivity(turnId, activityAt);
    return turn.owner;
  }

  getTurnOwner(turnId: string): ModeSession | undefined {
    return this.#turns.get(turnId)?.owner;
  }

  /** True while eviction would discard live ownership or continuation state. */
  hasResidentWork(): boolean {
    if (
      this.#sources.size > 0 ||
      this.#structuralAssociations.size > 0 ||
      this.#retiredDispositions.size > 0
    ) {
      return true;
    }
    for (const turn of this.#turns.values()) {
      if (turn.owner) {
        return true;
      }
    }
    return false;
  }

  transferTurn(fromTurnId: string, toTurnId: string): ModeSession | undefined {
    if (fromTurnId === toTurnId || this.#turns.has(toTurnId)) {
      return this.#turns.get(toTurnId)?.owner;
    }
    const turn = this.#turns.get(fromTurnId);
    if (!turn?.owner) {
      return undefined;
    }
    this.#repairTrackedRows(turn);
    this.#turns.delete(fromTurnId);
    this.#turns.set(toTurnId, {
      owner: turn.owner,
      rows: [],
      ...(turn.runtimeState ? { runtimeState: turn.runtimeState } : {}),
      ...(turn.terminalDisposition
        ? { terminalDisposition: turn.terminalDisposition }
        : {}),
    });
    return turn.owner;
  }

  getTerminalDisposition(
    turnId: string,
  ): ModeSessionTerminalDisposition | undefined {
    return this.#turns.get(turnId)?.terminalDisposition;
  }

  keepsSessionOpenAfterTurn(turnId: string): boolean {
    const owner = this.#turns.get(turnId)?.owner;
    if (!owner || this.#retiredDispositions.has(owner.id)) {
      return false;
    }
    return this.#hasSourceLifetimeSource(owner.id);
  }

  recordActivity(turnId: string, at: number): boolean {
    const turn = this.#turns.get(turnId);
    if (!turn?.owner) {
      return false;
    }
    const lastOwnedMessageId = lastStampedRow(turn.rows)?.id;
    return this.#mutateActiveSession(turn.owner.id, (session) =>
      this.#dependencies.updateActivity({
        id: session.id,
        conversationId: this.#conversationId,
        expectedRevision: session.revision,
        lastActivityAt: at,
        ...(lastOwnedMessageId ? { lastOwnedMessageId } : {}),
      }),
    );
  }

  recordStructuralWait(
    turnId: string,
    response: ModeSessionStructuralResponse,
  ): boolean {
    const turn = this.#turns.get(turnId);
    if (
      !turn?.owner ||
      !this.#readActiveSession(turn.owner.id) ||
      !this.#hasEligibleSource(turn.owner.id)
    ) {
      return false;
    }
    this.#structuralAssociations.set(
      associationKey(response.kind, response.responseId),
      {
        conversationId: this.#conversationId,
        kind: response.kind,
        owner: turn.owner,
      },
    );
    turn.runtimeState = "waiting";
    this.#publishRuntimeChange(turn.owner.id);
    return true;
  }

  invalidateStructuralWait(response: ModeSessionStructuralResponse): boolean {
    const association = this.#takeStructuralAssociation(response);
    if (!association) {
      return false;
    }
    if (this.#hasAssociationForOwner(association.owner.id)) {
      return true;
    }
    this.#clearRuntimeState(association.owner.id);
    this.#publishRuntimeChange(association.owner.id);
    return true;
  }

  settleStructuralWait(
    response: ModeSessionStructuralResponse,
    disposition: ModeSessionTerminalDisposition,
  ): boolean {
    const association = this.#takeStructuralAssociation(response);
    if (!association) {
      return false;
    }
    if (this.#hasAssociationForOwner(association.owner.id)) {
      return true;
    }
    if (this.#hasSourceLifetimeSource(association.owner.id)) {
      this.#clearRuntimeState(association.owner.id);
      this.#publishRuntimeChange(association.owner.id);
      return true;
    }
    this.#retiredDispositions.set(association.owner.id, disposition);
    for (const turn of this.#turns.values()) {
      if (turn.owner?.id === association.owner.id) {
        turn.terminalDisposition = disposition;
        turn.runtimeState = "finishing";
      }
    }
    this.#retireSourcesForOwner(association.owner.id);
    let settlementError: unknown;
    try {
      this.#publishRuntimeChange(association.owner.id);
    } catch (err) {
      settlementError = err;
    }
    try {
      this.#finalizeRetiredSessionIfSettled(association.owner.id);
    } catch (err) {
      settlementError ??= err;
    }
    if (settlementError) {
      throw settlementError;
    }
    return true;
  }

  invalidateAllStructuralWaits(): number {
    const ownerIds = new Set(
      [...this.#structuralAssociations.values()].map(
        (association) => association.owner.id,
      ),
    );
    const count = this.#structuralAssociations.size;
    this.#structuralAssociations.clear();
    for (const ownerId of ownerIds) {
      this.#clearRuntimeState(ownerId);
      this.#publishRuntimeChange(ownerId);
    }
    return count;
  }

  beginDraining(turnId: string): boolean {
    const turn = this.#turns.get(turnId);
    if (!turn?.owner || !this.#readActiveSession(turn.owner.id)) {
      return false;
    }
    turn.runtimeState = "finishing";
    this.#publishRuntimeChange(turn.owner.id);
    return true;
  }

  finalizeTurn(input: {
    turnId: string;
    status: "completed" | "interrupted";
    endedAt: number | null;
    endReason: string;
    lastActivityAt?: number;
  }): boolean {
    const turn = this.#turns.get(input.turnId);
    if (!turn?.owner) {
      return false;
    }
    this.#repairTrackedRows(turn);
    const lastOwnedMessageId = lastStampedRow(turn.rows)?.id;
    const finalized = this.#mutateActiveSession(turn.owner.id, (session) =>
      this.#dependencies.finalize({
        id: session.id,
        conversationId: this.#conversationId,
        expectedRevision: session.revision,
        status: input.status,
        endedAt: input.endedAt,
        endReason: input.endReason,
        ...(input.lastActivityAt !== undefined
          ? { lastActivityAt: input.lastActivityAt }
          : {}),
        ...(lastOwnedMessageId ? { lastOwnedMessageId } : {}),
      }),
    );
    if (finalized) {
      this.#turns.delete(input.turnId);
      this.#deleteAssociationsForOwner(turn.owner.id);
      this.#retireSourcesForOwner(turn.owner.id);
      this.#retiredDispositions.delete(turn.owner.id);
      this.#dependencies.publishMessagesChanged(this.#conversationId);
    }
    return finalized;
  }

  releaseTurn(
    turnId: string,
    fallbackDisposition?: ModeSessionTerminalDisposition,
  ): void {
    const turn = this.#turns.get(turnId);
    let repairError: unknown;
    if (turn?.owner) {
      try {
        this.#repairTrackedRows(turn);
      } catch (err) {
        repairError = err;
      }
    }
    const owner = turn?.owner;
    const shouldRetireOwner =
      owner !== undefined &&
      fallbackDisposition !== undefined &&
      !this.#hasAssociationForOwner(owner.id) &&
      !this.#hasSourceLifetimeSource(owner.id) &&
      !this.#retiredDispositions.has(owner.id);
    if (shouldRetireOwner) {
      this.#retiredDispositions.set(owner.id, fallbackDisposition);
      for (const currentTurn of this.#turns.values()) {
        if (currentTurn.owner?.id === owner.id) {
          currentTurn.terminalDisposition = fallbackDisposition;
          currentTurn.runtimeState = "finishing";
        }
      }
      this.#retireSourcesForOwner(owner.id);
    }
    this.#turns.delete(turnId);
    let retirementError: unknown;
    if (owner) {
      if (shouldRetireOwner) {
        try {
          this.#publishRuntimeChange(owner.id);
        } catch (err) {
          retirementError = err;
        }
      }
      try {
        this.#finalizeRetiredSessionIfSettled(owner.id);
      } catch (err) {
        retirementError ??= err;
      }
    }
    if (repairError) {
      throw repairError;
    }
    if (retirementError) {
      throw retirementError;
    }
  }

  descriptorFor(sessionId: string): ModeSessionDescriptor | undefined {
    const summary = this.#sessions.get(sessionId);
    if (!summary) {
      return undefined;
    }
    if (summary.status !== "active") {
      return { summary };
    }
    let hasOwnedTurn = false;
    for (const turn of this.#turns.values()) {
      if (turn.owner?.id !== sessionId) {
        continue;
      }
      hasOwnedTurn = true;
      if (turn.runtimeState) {
        return { summary, runtimeState: turn.runtimeState };
      }
    }
    if (!hasOwnedTurn && this.#hasAssociationForOwner(sessionId)) {
      return { summary, runtimeState: "waiting" };
    }
    return { summary };
  }

  describeSummary(summary: ModeSessionSummary): ModeSessionDescriptor {
    if (summary.conversationId !== this.#conversationId) {
      return { summary };
    }
    this.#sessions.set(summary.id, summary);
    return this.descriptorFor(summary.id) ?? { summary };
  }

  repairTrackedRows(turnId: string): boolean {
    const turn = this.#turns.get(turnId);
    if (!turn?.owner) {
      return false;
    }
    return this.#repairTrackedRows(turn);
  }

  #readActiveSession(sessionId: string): ModeSessionSummary | null {
    const session = this.#dependencies.getSession(
      this.#conversationId,
      sessionId,
    );
    if (!session || session.status !== "active") {
      if (session) {
        this.#sessions.set(session.id, session);
      }
      return null;
    }
    this.#sessions.set(session.id, session);
    return session;
  }

  #mutateActiveSession(
    sessionId: string,
    mutate: (session: ModeSessionSummary) => ModeSessionWriteResult,
  ): boolean {
    let session = this.#readActiveSession(sessionId);
    if (!session) {
      return false;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = mutate(session);
      if (result.ok) {
        this.#sessions.set(result.session.id, result.session);
        return true;
      }
      if (
        result.reason !== "stale_revision" ||
        !result.session ||
        result.session.status !== "active"
      ) {
        if (result.session) {
          this.#sessions.set(result.session.id, result.session);
        }
        return false;
      }
      session = result.session;
      this.#sessions.set(session.id, session);
    }
    return false;
  }

  #repairTrackedRows(turn: TurnState, publishMessagesChanged = true): boolean {
    if (!turn.owner) {
      return false;
    }
    let changed = false;
    for (const row of turn.rows) {
      changed = this.#stampRow(row, turn.owner) || changed;
    }
    const stampedRows = turn.rows.filter((row) => row.stamped);
    if (stampedRows.length > 0) {
      changed =
        this.#updateOrdinaryBoundaries(turn.owner, stampedRows) || changed;
    }
    if (changed && publishMessagesChanged) {
      this.#dependencies.publishMessagesChanged(this.#conversationId);
    }
    return changed;
  }

  #stampRow(row: TrackedRow, owner: ModeSession): boolean {
    if (row.stamped) {
      return false;
    }
    try {
      this.#dependencies.stampMessage(row.id, owner);
      row.stamped = true;
      return true;
    } catch {
      return false;
    }
  }

  #updateOrdinaryBoundaries(owner: ModeSession, rows: TrackedRow[]): boolean {
    if (rows.length === 0) {
      return false;
    }
    return this.#mutateActiveSession(owner.id, (session) => {
      const eligibleFirstRows = rows.filter((row) =>
        modeSessionRowStartsDisplay(owner.mode, row.startsDisplayBoundary),
      );
      const earliest = eligibleFirstRows.reduce<TrackedRow | undefined>(
        (current, row) => (!current || row.at < current.at ? row : current),
        undefined,
      );
      const firstIncluded =
        session.firstIncludedAt !== null &&
        session.firstIncludedMessageId !== null &&
        (!earliest || session.firstIncludedAt <= earliest.at)
          ? {
              at: session.firstIncludedAt,
              messageId: session.firstIncludedMessageId,
            }
          : earliest
            ? { at: earliest.at, messageId: earliest.id }
            : null;
      const lastOwnedMessageId = rows.at(-1)?.id ?? session.lastOwnedMessageId;
      const lastActivityAt = rows.reduce(
        (latest, row) => Math.max(latest, row.at),
        session.lastActivityAt,
      );
      if (
        session.firstIncludedAt === (firstIncluded?.at ?? null) &&
        session.firstIncludedMessageId === (firstIncluded?.messageId ?? null) &&
        session.lastActivityAt === lastActivityAt &&
        session.lastOwnedMessageId === lastOwnedMessageId
      ) {
        return { ok: true, session };
      }
      return this.#dependencies.updateBoundaries({
        id: session.id,
        conversationId: this.#conversationId,
        expectedRevision: session.revision,
        firstIncluded,
        lastActivityAt,
        lastOwnedMessageId,
      });
    });
  }

  #deleteAssociationsForOwner(sessionId: string): boolean {
    let deleted = false;
    for (const [key, association] of this.#structuralAssociations) {
      if (association.owner.id === sessionId) {
        this.#structuralAssociations.delete(key);
        deleted = true;
      }
    }
    return deleted;
  }

  #clearRuntimeState(sessionId: string): void {
    for (const turn of this.#turns.values()) {
      if (turn.owner?.id === sessionId) {
        turn.runtimeState = undefined;
      }
    }
  }

  #hasEligibleSource(sessionId: string): boolean {
    for (const source of this.#sources.values()) {
      if (source.session.id === sessionId) {
        return true;
      }
    }
    return false;
  }

  #retireSourcesForOwner(sessionId: string): void {
    for (const [key, source] of this.#sources) {
      if (source.session.id === sessionId) {
        this.#sources.delete(key);
      }
    }
  }

  #finalizeRetiredSessionIfSettled(sessionId: string): boolean {
    const disposition = this.#retiredDispositions.get(sessionId);
    if (!disposition) {
      return false;
    }
    for (const turn of this.#turns.values()) {
      if (turn.owner?.id === sessionId) {
        return false;
      }
    }
    const endedAt = Date.now();
    let finalized: boolean;
    try {
      finalized = this.#mutateActiveSession(sessionId, (session) =>
        this.#dependencies.finalize({
          id: session.id,
          conversationId: this.#conversationId,
          expectedRevision: session.revision,
          status: disposition.status,
          endedAt,
          endReason: disposition.endReason,
          lastActivityAt: endedAt,
        }),
      );
    } catch (err) {
      this.#retiredDispositions.delete(sessionId);
      throw err;
    }
    if (finalized) {
      this.#retiredDispositions.delete(sessionId);
      this.#dependencies.publishMessagesChanged(this.#conversationId);
    }
    return finalized;
  }

  #hasAssociationForOwner(sessionId: string): boolean {
    for (const association of this.#structuralAssociations.values()) {
      if (association.owner.id === sessionId) {
        return true;
      }
    }
    return false;
  }

  #hasSourceLifetimeSource(sessionId: string): boolean {
    for (const source of this.#sources.values()) {
      if (source.session.id === sessionId && source.lifetime === "source") {
        return true;
      }
    }
    return false;
  }

  #takeStructuralAssociation(
    response: ModeSessionStructuralResponse,
  ): StructuralAssociation | undefined {
    const key = associationKey(response.kind, response.responseId);
    const association = this.#structuralAssociations.get(key);
    if (!association || !this.#structuralAssociations.delete(key)) {
      return undefined;
    }
    return association;
  }

  #publishRuntimeChange(sessionId: string): boolean {
    const advanced = this.#mutateActiveSession(sessionId, (session) =>
      this.#dependencies.advanceRevision({
        id: session.id,
        conversationId: this.#conversationId,
        expectedRevision: session.revision,
      }),
    );
    if (advanced) {
      this.#dependencies.publishMessagesChanged(this.#conversationId);
    }
    return advanced;
  }
}

export function modeSessionStamp(
  mode: ModeSessionMode,
  id: string,
): ModeSession {
  return { mode, id };
}
