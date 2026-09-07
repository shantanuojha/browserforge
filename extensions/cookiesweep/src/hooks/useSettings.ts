import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  activityLogKey,
  loadSettings,
  normalizeSettings,
  settingsKey,
  updateSettings,
  type ActivityEntry,
  type Settings,
} from "../lib/settings.js";

export interface UseSettings {
  settings: Settings;
  loading: boolean;
  /** Apply a functional update and persist it. */
  update: (fn: (current: Settings) => Settings) => Promise<void>;
  /** Shallow-merge a partial object and persist it. */
  patch: (partial: Partial<Settings>) => Promise<void>;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS, lists: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setLoading(false);
    });
    const unwatch = settingsKey.watch((next) => {
      if (!cancelled) setSettings(normalizeSettings(next));
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  const update = useCallback(async (fn: (current: Settings) => Settings) => {
    const next = await updateSettings(fn);
    setSettings(next);
  }, []);

  const patch = useCallback(
    (partial: Partial<Settings>) => update((current) => ({ ...current, ...partial })),
    [update],
  );

  return { settings, loading, update, patch };
}

export function useActivityLog(): { log: ActivityEntry[]; clear: () => Promise<void> } {
  const [log, setLog] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void activityLogKey.get().then((entries) => {
      if (!cancelled) setLog(Array.isArray(entries) ? entries : []);
    });
    const unwatch = activityLogKey.watch((next) => {
      if (!cancelled) setLog(Array.isArray(next) ? next : []);
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  const clear = useCallback(async () => {
    await activityLogKey.set([]);
    setLog([]);
  }, []);

  return { log, clear };
}
