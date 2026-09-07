import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  watchSettings,
  type Settings,
} from "@/lib/settings";

export function useSettings(): [Settings, (next: Settings) => Promise<void>, boolean] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoaded(true);
    });
    const unwatch = watchSettings((s) => setSettings(s));
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  const update = useCallback(async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  return [settings, update, loaded];
}
