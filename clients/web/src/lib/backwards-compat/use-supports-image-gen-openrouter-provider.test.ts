/**
 * Pins what `MIN_VERSION` admits.
 *
 * The constant is `0.12.1-dev.0`, a pending-feature floor. A tidy-up that
 * drops the pre-release suffix to plain `0.12.1` would offer OpenRouter to
 * every assistant on released 0.12.1, whose config enum has no
 * `openrouter` member.
 *
 * These assert against `versionSupports` rather than the hook: the hook
 * adds store hydration, which is `useAssistantSupports`'s concern and
 * already covered by `utils.test.ts`. What is specific to this gate is
 * which VERSIONS pass.
 */

import { describe, expect, test } from "bun:test";

import { versionSupports } from "./utils";
import { MIN_VERSION } from "./use-supports-image-gen-openrouter-provider";

describe("image-gen OpenRouter version gate", () => {
  test("admits a dev build of the current package version", () => {
    expect(
      versionSupports("0.12.1-dev.202609171400.3af12c5", MIN_VERSION),
    ).toBe(true);
  });

  test("admits a local build of the current package version", () => {
    expect(
      versionSupports("0.12.1-local.20260917140000.3af12c5", MIN_VERSION),
    ).toBe(true);
  });

  test("excludes the 0.12.1 stable release", () => {
    expect(versionSupports("0.12.1", MIN_VERSION)).toBe(false);
  });

  test("excludes everything below 0.12.1", () => {
    expect(versionSupports("0.12.0", MIN_VERSION)).toBe(false);
    expect(versionSupports("0.11.11", MIN_VERSION)).toBe(false);
    expect(
      versionSupports("0.12.0-dev.202609171400.3af12c5", MIN_VERSION),
    ).toBe(false);
  });

  test("admits later bases", () => {
    expect(versionSupports("0.12.2", MIN_VERSION)).toBe(true);
    expect(versionSupports("0.13.0", MIN_VERSION)).toBe(true);
    expect(versionSupports("1.0.0", MIN_VERSION)).toBe(true);
  });

  test("stays closed on an unknown or unparseable version", () => {
    expect(versionSupports(null, MIN_VERSION)).toBe(false);
    expect(versionSupports(undefined, MIN_VERSION)).toBe(false);
    expect(versionSupports("not-a-version", MIN_VERSION)).toBe(false);
  });
});
