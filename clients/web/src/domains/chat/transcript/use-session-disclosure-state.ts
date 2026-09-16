import { useCallback, useEffect, useState } from "react";

interface SessionDisclosureVisitState {
  conversationId: string | null;
  observedLiveSessionIds: ReadonlySet<string>;
  explicitChoices: ReadonlyMap<string, boolean>;
}

export interface SessionDisclosureState {
  isSessionOpen: (sessionId: string) => boolean;
  isSessionExplicitlyClosed?: (sessionId: string) => boolean;
  observeLiveSession: (sessionId: string) => void;
  setSessionOpen: (sessionId: string, open: boolean) => void;
}

function emptyVisitState(
  conversationId: string | null,
): SessionDisclosureVisitState {
  return {
    conversationId,
    observedLiveSessionIds: new Set(),
    explicitChoices: new Map(),
  };
}

/**
 * Owns disclosure choices for one conversation visit. Mount this beside the
 * active conversation identity, above transcript surfaces that can remount.
 */
export function useSessionDisclosureState(
  conversationId: string | null,
): SessionDisclosureState {
  const [visit, setVisit] = useState<SessionDisclosureVisitState>(() =>
    emptyVisitState(conversationId),
  );

  useEffect(() => {
    setVisit((current) =>
      current.conversationId === conversationId
        ? current
        : emptyVisitState(conversationId),
    );
  }, [conversationId]);

  const observeLiveSession = useCallback(
    (sessionId: string) => {
      if (!conversationId || sessionId.length === 0) {
        return;
      }
      setVisit((current) => {
        if (
          current.conversationId !== conversationId ||
          current.observedLiveSessionIds.has(sessionId)
        ) {
          return current;
        }
        return {
          ...current,
          observedLiveSessionIds: new Set([
            ...current.observedLiveSessionIds,
            sessionId,
          ]),
        };
      });
    },
    [conversationId],
  );

  const setSessionOpen = useCallback(
    (sessionId: string, open: boolean) => {
      if (!conversationId || sessionId.length === 0) {
        return;
      }
      setVisit((current) => {
        if (current.conversationId !== conversationId) {
          return current;
        }
        if (current.explicitChoices.get(sessionId) === open) {
          return current;
        }
        const explicitChoices = new Map(current.explicitChoices);
        explicitChoices.set(sessionId, open);
        return { ...current, explicitChoices };
      });
    },
    [conversationId],
  );

  const isSessionOpen = useCallback(
    (sessionId: string): boolean => {
      if (visit.conversationId !== conversationId || sessionId.length === 0) {
        return false;
      }
      const explicitChoice = visit.explicitChoices.get(sessionId);
      return explicitChoice ?? visit.observedLiveSessionIds.has(sessionId);
    },
    [conversationId, visit],
  );

  const isSessionExplicitlyClosed = useCallback(
    (sessionId: string): boolean =>
      visit.conversationId === conversationId &&
      visit.explicitChoices.get(sessionId) === false,
    [conversationId, visit],
  );

  return {
    isSessionOpen,
    isSessionExplicitlyClosed,
    observeLiveSession,
    setSessionOpen,
  };
}
