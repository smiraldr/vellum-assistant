import { useSyncExternalStore } from "react";

const TICK_INTERVAL_MS = 1_000;

type ClockListener = () => void;

const listeners = new Set<ClockListener>();
let clockNow = Date.now();
let intervalId: ReturnType<typeof setInterval> | null = null;
let listeningForVisibility = false;

function documentIsVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function publishCurrentTime(): void {
  clockNow = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

function stopClock(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function startClock(): void {
  if (intervalId === null && listeners.size > 0 && documentIsVisible()) {
    intervalId = setInterval(publishCurrentTime, TICK_INTERVAL_MS);
  }
}

function handleVisibilityChange(): void {
  if (!documentIsVisible()) {
    stopClock();
    return;
  }
  publishCurrentTime();
  startClock();
}

function subscribeClock(listener: ClockListener): () => void {
  listeners.add(listener);
  clockNow = Date.now();
  if (!listeningForVisibility && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    listeningForVisibility = true;
  }
  startClock();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) {
      return;
    }
    stopClock();
    if (listeningForVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      listeningForVisibility = false;
    }
  };
}

function subscribeDisabled(): () => void {
  return () => {};
}

function getClockSnapshot(): number {
  return clockNow;
}

function getDisabledSnapshot(): null {
  return null;
}

/**
 * Returns one shared coarse clock while this summary is active and visible.
 * The caller owns runtime and viewport eligibility through `enabled`.
 */
export function useSessionDurationClock(enabled: boolean): number | null {
  return useSyncExternalStore(
    enabled ? subscribeClock : subscribeDisabled,
    enabled ? getClockSnapshot : getDisabledSnapshot,
    getDisabledSnapshot,
  );
}
