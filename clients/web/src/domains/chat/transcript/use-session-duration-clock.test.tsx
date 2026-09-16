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

import { publish } from "@/lib/event-bus";
import { publishElectronWindowAttentionSource } from "@/runtime/event-sources/electron-window-attention";
import { __resetLifecycleEdgeForTests } from "@/runtime/event-sources/lifecycle-edge";
import { subscribeToWindowAttention } from "@/runtime/window-attention";

import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import { useSessionDurationClock } from "./use-session-duration-clock";

const START = 1_700_000_000_000;
const TIMER_ID = 1 as unknown as ReturnType<typeof setInterval>;
const originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

beforeEach(() => {
  __resetLifecycleEdgeForTests();
  setSystemTime(new Date(START));
  publish("app.resume", { signal: "visibility" });
});

afterEach(() => {
  cleanup();
  setSystemTime();
  mock.restore();
  if (originalVisibilityStateDescriptor) {
    Object.defineProperty(
      document,
      "visibilityState",
      originalVisibilityStateDescriptor,
    );
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("starts suspended when the document is initially hidden", () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const { result } = renderHook(() => useSessionDurationClock(true));

  expect(result.current).toBe(START);
  expect(interval).not.toHaveBeenCalled();

  setSystemTime(new Date(START + 5_000));
  act(() => publish("app.resume", { signal: "visibility" }));

  expect(result.current).toBe(START + 5_000);
  expect(interval).toHaveBeenCalledTimes(1);
});

test("starts suspended when an Electron window is already minimized", () => {
  let sendWindowAttention:
    ((payload: WindowAttentionPayload) => void) | undefined;
  window.vellum = {
    platform: "electron",
    notifications: {
      onWindowAttention: (
        callback: (payload: WindowAttentionPayload) => void,
      ) => {
        sendWindowAttention = callback;
        return () => {
          sendWindowAttention = undefined;
        };
      },
    },
  } as unknown as Window["vellum"];
  const unsubscribeWindowAttention = subscribeToWindowAttention(
    () => undefined,
  );
  sendWindowAttention?.({
    visible: true,
    focused: true,
    minimized: true,
  });
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );

  try {
    const { result } = renderHook(() => useSessionDurationClock(true));

    expect(result.current).toBe(START);
    expect(interval).not.toHaveBeenCalled();

    setSystemTime(new Date(START + 5_000));
    act(() => publish("app.resume", { signal: "window_attention" }));

    expect(result.current).toBe(START + 5_000);
    expect(interval).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribeWindowAttention();
    delete window.vellum;
  }
});

test("stops when the first Electron payload reports a minimized window", () => {
  let sendWindowAttention:
    ((payload: WindowAttentionPayload) => void) | undefined;
  window.vellum = {
    platform: "electron",
    notifications: {
      onWindowAttention: (
        callback: (payload: WindowAttentionPayload) => void,
      ) => {
        sendWindowAttention = callback;
        return () => {
          sendWindowAttention = undefined;
        };
      },
    },
  } as unknown as Window["vellum"];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  renderHook(() => useSessionDurationClock(true));
  const stopWindowAttention = publishElectronWindowAttentionSource();

  try {
    expect(interval).toHaveBeenCalledTimes(1);

    act(() =>
      sendWindowAttention?.({
        visible: true,
        focused: false,
        minimized: true,
      }),
    );

    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    stopWindowAttention();
    delete window.vellum;
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

test("suspends on app hidden and catches up on app resume", () => {
  const ticks: Array<() => void> = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: TimerHandler,
  ) => {
    ticks.push(callback as () => void);
    return TIMER_ID;
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { result } = renderHook(() => useSessionDurationClock(true));

  act(() => publish("app.hidden", { signal: "window_attention" }));
  expect(clear).toHaveBeenCalledTimes(1);
  setSystemTime(new Date(START + 5_000));
  expect(result.current).toBe(START);

  act(() => publish("app.resume", { signal: "window_attention" }));
  expect(result.current).toBe(START + 5_000);
  expect(interval).toHaveBeenCalledTimes(2);
});

test("does not treat network recovery as an app resume", () => {
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    (() => TIMER_ID) as unknown as typeof setInterval,
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const { result } = renderHook(() => useSessionDurationClock(true));

  act(() => publish("app.hidden", { signal: "visibility" }));
  setSystemTime(new Date(START + 5_000));
  act(() => publish("app.resume", { signal: "online" }));

  expect(result.current).toBe(START);
  expect(interval).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
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
