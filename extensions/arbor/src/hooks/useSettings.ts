import { useCallback, useEffect, useState } from "react";
import { loadSettings, saveSettings, watchSettings } from "@/adapters/settings-store";
import { DEFAULT_SETTINGS, type Settings, type ThemeMode } from "@/lib/settings";

/** Apply the theme choice to the document root (every extension page does this once). */
export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

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
