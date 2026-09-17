/**
 * Backwards-compat gate: `openrouter` as an image-generation provider value.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. Daemons older than this change validate
 * `services["image-generation"].provider` against an enum that has no
 * `openrouter` member, so writing it can make the daemon's next config
 * reload reject or reset the image-generation section while the UI reports
 * a successful save.
 *
 * On the `false` branch the settings card hides OpenRouter. There is no
 * legacy write shape that older daemons can accept for this provider.
 *
 * MIN_VERSION uses the pending-feature floor `0.12.1-dev.0`. The enum
 * change has not landed on main, so an exact `dev-release.yaml` stamp
 * would name a minute that routeless main builds also pass. The
 * pre-release suffix excludes released 0.12.1 (cut without this
 * provider) while admitting 0.12.1-dev / 0.12.1-local builds and every
 * later base. After this lands on main, rewrite the floor to the first
 * main-line `dev-release.yaml` stamp that carries the enum.
 */
import {
  assistantSupports,
  useAssistantSupports,
} from "./utils";

export const MIN_VERSION = "0.12.1-dev.0";

/**
 * Snapshot gate for the save path: whether the active assistant accepts
 * `provider: "openrouter"` in the image-generation config. Callers should
 * `await whenAssistantVersionKnown()` before reading.
 */
export function supportsImageGenOpenRouterProvider(): boolean {
  return assistantSupports(MIN_VERSION);
}

/**
 * Render gate for the provider picker. Subscribes to the identity store
 * so OpenRouter appears once a supported version hydrates.
 */
export function useSupportsImageGenOpenRouterProvider(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
