import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useSessionDurationClock } from "./use-session-duration-clock";

const START = 1_700_000_000_000;
const TIMER_ID = 1 as unknown as ReturnType<typeof setInterval>;
const realVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);
let visibilityState: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState): void {
  visibilityState = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setSystemTime(new Date(START));
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  cleanup();
  setSystemTime();
  mock.restore();
  if (realVisibilityState) {
    Object.defineProperty(document, "visibilityState", realVisibilityState);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

test("shares one interval across enabled summaries", () => {
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: TimerHandler,
  ) => {
    tick = callback as () => void;
    return TIMER_ID;
  }) as unknown as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { result } = renderHook(() => [
    useSessionDurationClock(true),
    useSessionDurationClock(true),
  ]);

  expect(interval).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual([START, START]);

  setSystemTime(new Date(START + 1_000));
  act(() => tick?.());
  expect(result.current).toEqual([START + 1_000, START + 1_000]);
});

test("suspends while the document is hidden and catches up when visible", () => {
  const ticks: Array<() => void> = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: TimerHandler,
  ) => {
    ticks.push(callback as () => void);
    return TIMER_ID;
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { result } = renderHook(() => useSessionDurationClock(true));

  setVisibility("hidden");
  expect(clear).toHaveBeenCalledTimes(1);
  setSystemTime(new Date(START + 5_000));
  expect(result.current).toBe(START);

  act(() => setVisibility("visible"));
  expect(result.current).toBe(START + 5_000);
  expect(interval).toHaveBeenCalledTimes(2);
});

test("caller-controlled offscreen suspension unsubscribes and resumes", () => {
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { result, rerender } = renderHook(
    ({ enabled }) => useSessionDurationClock(enabled),
    { initialProps: { enabled: true } },
  );

  rerender({ enabled: false });
  expect(result.current).toBeNull();
  expect(clear).toHaveBeenCalledTimes(1);

  setSystemTime(new Date(START + 10_000));
  rerender({ enabled: true });
  expect(result.current).toBe(START + 10_000);
  expect(interval).toHaveBeenCalledTimes(2);
});

test("tears down after the final subscriber unmounts", () => {
  spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const first = renderHook(() => useSessionDurationClock(true));
  const second = renderHook(() => useSessionDurationClock(true));

  first.unmount();
  expect(clear).not.toHaveBeenCalled();
  second.unmount();
  expect(clear).toHaveBeenCalledTimes(1);
});

test("disabled summaries do not subscribe", () => {
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const { result } = renderHook(() => useSessionDurationClock(false));

  expect(result.current).toBeNull();
  expect(interval).not.toHaveBeenCalled();
});
