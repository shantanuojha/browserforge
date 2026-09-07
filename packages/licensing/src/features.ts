import { isProState } from "./client.js";
import type { LicenseClient, LicenseState } from "./types.js";

export type FeatureTier = "free" | "pro";

export interface FeatureGate<F extends string> {
  readonly features: Readonly<Record<F, FeatureTier>>;
  /**
   * Synchronous check against the cached licence state. Before `init()` resolves only
   * `free` features are allowed, so UI never flashes Pro-only controls.
   */
  can(feature: F): boolean;
  tierOf(feature: F): FeatureTier;
  /** Loads the current state from the client and subscribes to changes. Idempotent. */
  init(client: LicenseClient): Promise<void>;
  /** Stops listening; `can()` keeps answering from the last cached state. */
  dispose(): void;
  isReady(): boolean;
  getState(): LicenseState | undefined;
}

/**
 * `defineFeatures({ backups: "pro", drive: "pro", tree: "free" })` returns a typed gate whose
 * `can("backups")` answers synchronously once `init(client)` has run.
 */
export function defineFeatures<const F extends Record<string, FeatureTier>>(
  features: F,
): FeatureGate<keyof F & string> {
  type Name = keyof F & string;
  let state: LicenseState | undefined;
  let unsubscribe: (() => void) | undefined;
  let ready = false;

  const tierOf = (feature: Name): FeatureTier => features[feature] as FeatureTier;

  return {
    features,
    tierOf,
    can(feature: Name) {
      if (tierOf(feature) === "free") return true;
      return isProState(state);
    },
    async init(client) {
      unsubscribe?.();
      unsubscribe = client.onChange((next) => {
        state = next;
      });
      state = await client.getState();
      ready = true;
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
    isReady: () => ready,
    getState: () => state,
  };
}
