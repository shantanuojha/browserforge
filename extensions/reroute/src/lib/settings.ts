/** User settings. The stored shape may be partial (older versions); `withDefaults` completes it. */

export interface Settings {
  /** Static tracking-parameter ruleset enabled. */
  trackingEnabled: boolean;
  /** Pro: mirror rules to storage.sync. */
  syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  trackingEnabled: true,
  syncEnabled: false,
});

export function withSettingsDefaults(stored: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** True when this change switched sync on (the moment a device joins the shared rule set). */
export function syncJustEnabled(next: Settings | null, previous: Settings | null): boolean {
  return next?.syncEnabled === true && previous?.syncEnabled !== true;
}
